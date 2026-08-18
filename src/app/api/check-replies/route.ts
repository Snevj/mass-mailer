import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchIncomingMessages } from "@/lib/replies";
import { decryptSecret } from "@/lib/crypto";
import { cronBearerOk } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function normalizeMsgId(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return t.startsWith("<") ? t : `<${t.replace(/^[<\s]+|[>\s]+$/g, "")}>`;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Bounces (NDRs) come FROM mailer-daemon, not from the recipient, so they
// can't be matched by from-address like a reply. The failed recipient's
// address is embedded in the bounce body (DSN report / quoted headers) —
// pull out email addresses there and match the first one that's a known
// recipient, excluding the sender's own address (which also appears in
// most bounce bodies as the original From).
function extractBouncedRecipient(
  bodyText: string | null,
  byEmail: Map<string, { id: string; campaign_id: string; status: string }>,
  senderEmail: string
): { id: string; campaign_id: string; status: string } | undefined {
  if (!bodyText) return undefined;
  const found = bodyText.match(EMAIL_RE);
  if (!found) return undefined;
  for (const raw of found) {
    const addr = raw.toLowerCase();
    if (addr === senderEmail.toLowerCase()) continue;
    const hit = byEmail.get(addr);
    if (hit) return hit;
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  if (!cronBearerOk(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();

  // Reply checking is opt-in (default OFF) so the heavy IMAP+mailparser path
  // doesn't burn Vercel memory-hours unless the user actually wants replies.
  // Toggle from /replies in the app, or directly via:
  //   update public.app_settings set value='true' where key='reply_check_enabled';
  const { data: flag } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "reply_check_enabled")
    .maybeSingle();
  if (flag?.value !== "true") {
    return NextResponse.json({ status: "disabled" });
  }

  const { data: allSenders } = await db.from("senders").select("id, email, app_password, provider");
  // Graph (OAuth) senders have no IMAP password — reply reading for them would
  // need a separate Graph Mail.Read flow, so skip them here for now.
  const senders = (allSenders ?? []).filter((s) => s.provider !== "microsoft_graph");
  if (senders.length === 0) return NextResponse.json({ status: "no_senders" });

  const since = new Date(Date.now() - 7 * 86400 * 1000);
  const results: Array<{
    sender: string;
    checked: number;
    matched_by_thread: number;
    matched_by_from: number;
    skipped_auto: number;
    skipped_bounce: number;
    saved: number;
    marked_replied: number;
    marked_bounced: number;
  }> = [];

  for (const s of senders) {
    let messages;
    try {
      messages = await fetchIncomingMessages(
        { email: s.email, appPassword: decryptSecret(s.app_password), provider: s.provider },
        since
      );
    } catch {
      results.push({
        sender: s.email, checked: 0,
        matched_by_thread: 0, matched_by_from: 0,
        skipped_auto: 0, skipped_bounce: 0, saved: 0, marked_replied: -1, marked_bounced: 0,
      });
      continue;
    }
    if (messages.length === 0) {
      results.push({
        sender: s.email, checked: 0,
        matched_by_thread: 0, matched_by_from: 0,
        skipped_auto: 0, skipped_bounce: 0, saved: 0, marked_replied: 0, marked_bounced: 0,
      });
      continue;
    }

    // Campaigns for this sender
    const { data: campaignRows } = await db
      .from("campaigns")
      .select("id")
      .eq("sender_id", s.id);
    const campaignIds = (campaignRows ?? []).map((c) => c.id);
    if (campaignIds.length === 0) {
      results.push({
        sender: s.email, checked: messages.length,
        matched_by_thread: 0, matched_by_from: 0,
        skipped_auto: 0, skipped_bounce: 0, saved: 0, marked_replied: 0, marked_bounced: 0,
      });
      continue;
    }

    // Fetch recipients in this sender's campaigns (email + message_id both matter).
    const { data: recipientsRows } = await db
      .from("recipients")
      .select("id, email, campaign_id, status, message_id")
      .in("campaign_id", campaignIds)
      .range(0, 99999);

    // Two indexes: by message_id (authoritative — this is a genuine thread reply)
    // and by email (fallback — used only when the reply also carries SOME
    // In-Reply-To/References, which rules out unrelated mail from that address).
    const byMsgId = new Map<string, { id: string; campaign_id: string; status: string }>();
    const byEmail = new Map<string, { id: string; campaign_id: string; status: string }>();
    for (const r of recipientsRows ?? []) {
      const mid = normalizeMsgId(r.message_id);
      if (mid && !byMsgId.has(mid)) {
        byMsgId.set(mid, { id: r.id, campaign_id: r.campaign_id, status: r.status });
      }
      const lo = r.email.toLowerCase();
      if (!byEmail.has(lo)) {
        byEmail.set(lo, { id: r.id, campaign_id: r.campaign_id, status: r.status });
      }
    }

    let savedCount = 0;
    let matchedByThread = 0;
    let matchedByFrom = 0;
    let skippedAuto = 0;
    let skippedBounce = 0;
    const repliedRecipientIds = new Set<string>();
    const bouncedRecipientIds = new Set<string>();

    for (const msg of messages) {
      // Bounces (mailer-daemon / DSNs) aren't a reply, but they DO mean the
      // address is dead — find which recipient it was for and stop sending
      // to them (mark bounced, cancel any pending follow-up), instead of
      // just counting the bounce and moving on.
      if (msg.is_bounce) {
        skippedBounce++;
        const hit = extractBouncedRecipient(msg.body_text, byEmail, s.email);
        if (hit && hit.status !== "bounced" && hit.status !== "unsubscribed") {
          bouncedRecipientIds.add(hit.id);
        }
        continue;
      }

      // 1) Authoritative match: In-Reply-To / References contains one of our
      //    outbound Message-IDs. Guaranteed genuine reply to our campaign.
      let hit: { id: string; campaign_id: string; status: string } | undefined;
      const candidateMsgIds = [
        ...(msg.in_reply_to ? [msg.in_reply_to] : []),
        ...msg.references,
      ];
      for (const mid of candidateMsgIds) {
        const found = byMsgId.get(mid);
        if (found) { hit = found; break; }
      }
      if (hit) matchedByThread++;

      // 2) Fallback: from-address matches a recipient we sent to, AND the
      //    message carries some threading header (even if it didn't match one
      //    of ours above — some clients rewrite Message-IDs mid-thread). This
      //    is what rules out unrelated mail from that address; without it,
      //    literally any email from a past recipient — a new unrelated
      //    thread, a forwarded newsletter, anything — would be misfiled as a
      //    reply and silently kill that recipient's follow-ups.
      const hasThreadingHeaders = !!msg.in_reply_to || msg.references.length > 0;
      if (!hit && hasThreadingHeaders) {
        hit = byEmail.get(msg.from);
        if (hit) matchedByFrom++;
      }
      if (!hit) continue;

      const { error } = await db.from("replies").upsert(
        {
          recipient_id: hit.id,
          campaign_id: hit.campaign_id,
          from_email: msg.from,
          subject: msg.subject,
          snippet: msg.snippet,
          body_text: msg.body_text,
          body_html: msg.body_html,
          received_at: msg.date?.toISOString() ?? null,
        },
        { onConflict: "recipient_id,received_at" }
      );
      if (!error) savedCount++;

      if (hit.status === "sent" || hit.status === "pending") {
        repliedRecipientIds.add(hit.id);
      }
    }

    let markedReplied = 0;
    if (repliedRecipientIds.size > 0) {
      const { data: updated, error: upErr } = await db
        .from("recipients")
        .update({
          status: "replied",
          replied_at: new Date().toISOString(),
          next_follow_up_at: null,
        })
        .in("id", Array.from(repliedRecipientIds))
        .select("id");
      if (upErr) console.error("[check-replies] update failed:", upErr);
      markedReplied = updated?.length ?? 0;
    }

    let markedBounced = 0;
    if (bouncedRecipientIds.size > 0) {
      const { data: updated, error: upErr } = await db
        .from("recipients")
        .update({
          status: "bounced",
          next_follow_up_at: null,
          error: "Bounced (delivery failed)",
        })
        .in("id", Array.from(bouncedRecipientIds))
        .select("id");
      if (upErr) console.error("[check-replies] bounce update failed:", upErr);
      markedBounced = updated?.length ?? 0;
    }

    results.push({
      sender: s.email,
      checked: messages.length,
      matched_by_thread: matchedByThread,
      matched_by_from: matchedByFrom,
      skipped_auto: skippedAuto,
      skipped_bounce: skippedBounce,
      saved: savedCount,
      marked_replied: markedReplied,
      marked_bounced: markedBounced,
    });
  }

  return NextResponse.json({ status: "ok", results });
}
