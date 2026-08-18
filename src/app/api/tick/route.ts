import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, type MailProvider } from "@/lib/supabase";
import { sendMail } from "@/lib/mail";
import { render, toHtml, toPlain } from "@/lib/template";
import { inWindow, dayKey } from "@/lib/time";
import { signToken, appUrl, cronBearerOk } from "@/lib/tokens";
import { downloadAttachment } from "@/lib/attachment";
import { decryptSecret } from "@/lib/crypto";
import { warmupCapForSender } from "@/lib/warmup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauth() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!cronBearerOk(req.headers.get("authorization"))) return unauth();

  const db = supabaseAdmin();
  const now = new Date();

  // Multi-campaign scheduler: rotate fairly across all running campaigns
  // so one long-running campaign doesn't starve the others. Pick the
  // campaign whose most recent send is the oldest (NULL = never sent = top).
  const { data: running } = await db
    .from("campaigns")
    .select("*")
    .eq("status", "running")
    .order("created_at", { ascending: true });

  if (!running || running.length === 0) {
    return NextResponse.json({ status: "no_running_campaign" });
  }

  // Fetch last send per running campaign in one query, then bucket client-side
  const campaignIds = running.map((c) => c.id);
  const { data: recentLogs } = await db
    .from("send_log")
    .select("campaign_id, sent_at")
    .in("campaign_id", campaignIds)
    .order("sent_at", { ascending: false });
  const lastSendMs = new Map<string, number>();
  for (const row of recentLogs ?? []) {
    if (!lastSendMs.has(row.campaign_id)) {
      lastSendMs.set(row.campaign_id, new Date(row.sent_at).getTime());
    }
  }

  // Sort: never-sent first (0), then oldest-last-send first.
  running.sort((a, b) => (lastSendMs.get(a.id) ?? 0) - (lastSendMs.get(b.id) ?? 0));

  // Pre-fetch warmup state for every sender referenced by the running campaigns.
  const senderIds = Array.from(new Set(running.map((c) => c.sender_id).filter((x): x is string => !!x)));
  const warmupMap = new Map<string, { warmup_enabled: boolean; warmup_started_at: string | null }>();
  if (senderIds.length > 0) {
    const { data: sendersInfo } = await db
      .from("senders")
      .select("id, warmup_enabled, warmup_started_at")
      .in("id", senderIds);
    for (const s of sendersInfo ?? []) {
      warmupMap.set(s.id, { warmup_enabled: !!s.warmup_enabled, warmup_started_at: s.warmup_started_at });
    }
  }

  // Map every sender to ALL campaigns that use it (any status), so the warmup
  // cap reflects total volume from that mailbox, not just this one campaign.
  // Without this, two campaigns sharing a sender could each independently hit
  // daily_cap and double the sender's real send volume for the day.
  const senderCampaignIds = new Map<string, string[]>();
  if (senderIds.length > 0) {
    const { data: sameSenderCampaigns } = await db
      .from("campaigns")
      .select("id, sender_id")
      .in("sender_id", senderIds);
    for (const sc of sameSenderCampaigns ?? []) {
      if (!sc.sender_id) continue;
      const arr = senderCampaignIds.get(sc.sender_id) ?? [];
      arr.push(sc.id);
      senderCampaignIds.set(sc.sender_id, arr);
    }
  }

  // Walk the sorted list — first campaign that passes ALL gates (window,
  // start_at, gap, daily cap incl. warmup) wins the tick.
  let campaign: typeof running[0] | null = null;
  let todayCount = 0;
  const skipped: Array<{ id: string; name: string; reason: string }> = [];

  for (const c of running) {
    const tz = c.timezone || "Asia/Kolkata";

    if (!inWindow(now, tz, c.schedule, c.window_start_hour, c.window_end_hour)) {
      skipped.push({ id: c.id, name: c.name, reason: "outside_window" });
      continue;
    }
    if (c.start_at && new Date(c.start_at) > now) {
      skipped.push({ id: c.id, name: c.name, reason: "not_yet_started" });
      continue;
    }
    const lastTs = lastSendMs.get(c.id);
    if (lastTs) {
      const gapMs = (c.gap_seconds ?? 120) * 1000;
      if (now.getTime() - lastTs < gapMs) {
        skipped.push({ id: c.id, name: c.name, reason: "gap_not_elapsed" });
        continue;
      }
    }
    const today = dayKey(now, tz);
    const { count } = await db
      .from("send_log")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", c.id)
      .eq("day", today);
    if ((count ?? 0) >= c.daily_cap) {
      skipped.push({ id: c.id, name: c.name, reason: "daily_cap_reached" });
      continue;
    }

    // Warmup cap is enforced against the sender/mailbox's TOTAL sends today
    // across every campaign using it, not just this campaign's count —
    // otherwise two running campaigns on the same sender could each burn
    // their own daily_cap and double the real volume out of that mailbox.
    const warmupInfo = c.sender_id ? warmupMap.get(c.sender_id) : undefined;
    const warmupCap = warmupInfo ? warmupCapForSender(warmupInfo, now) : Infinity;
    if (c.sender_id && Number.isFinite(warmupCap)) {
      const sameSenderIds = senderCampaignIds.get(c.sender_id) ?? [c.id];
      const { count: senderTodayCount } = await db
        .from("send_log")
        .select("*", { count: "exact", head: true })
        .in("campaign_id", sameSenderIds)
        .eq("day", today);
      if ((senderTodayCount ?? 0) >= warmupCap) {
        skipped.push({ id: c.id, name: c.name, reason: "warmup_cap_reached" });
        continue;
      }
    }

    campaign = c;
    todayCount = count ?? 0;
    break;
  }

  if (!campaign) {
    return NextResponse.json({ status: "all_throttled", skipped });
  }

  const tz = campaign.timezone || "Asia/Kolkata";
  const today = dayKey(now, tz);

  // resolve sender creds for the winning campaign
  let sender: { email: string; appPassword: string; fromName?: string | null; provider?: MailProvider | null; msTenantId?: string | null; msClientId?: string | null } | null = null;
  if (campaign.sender_id) {
    const { data: s } = await db
      .from("senders")
      .select("email, app_password, from_name, provider, ms_tenant_id, ms_client_id")
      .eq("id", campaign.sender_id)
      .maybeSingle();
    if (s) sender = { email: s.email, appPassword: decryptSecret(s.app_password), fromName: s.from_name, provider: s.provider, msTenantId: s.ms_tenant_id, msClientId: s.ms_client_id };
  }

  // ----- pick next thing to send: follow-up > retry > fresh -----
  const nowIso = now.toISOString();
  let kind: "initial" | "follow_up" | "retry" = "initial";
  let recipient: any = null;
  let step: any = null;

  if (campaign.follow_ups_enabled) {
    const { data: due } = await db
      .from("recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "sent")
      .not("next_follow_up_at", "is", null)
      .lte("next_follow_up_at", nowIso)
      .order("next_follow_up_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (due) {
      recipient = due;
      kind = "follow_up";
      const { data: s } = await db
        .from("follow_up_steps")
        .select("*")
        .eq("campaign_id", campaign.id)
        .eq("step_number", due.follow_up_count + 1)
        .maybeSingle();
      if (!s) {
        // no step defined → clear schedule, move on
        await db.from("recipients").update({ next_follow_up_at: null }).eq("id", due.id);
        return NextResponse.json({ status: "follow_up_step_missing", recipient: due.email });
      }
      step = s;
    }
  }

  if (!recipient) {
    const { data: retryR } = await db
      .from("recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .gt("retry_count", 0)
      .not("next_retry_at", "is", null)
      .lte("next_retry_at", nowIso)
      .order("next_retry_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (retryR) { recipient = retryR; kind = "retry"; }
  }

  if (!recipient) {
    const { data: fresh } = await db
      .from("recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .eq("retry_count", 0)
      .order("row_index", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (fresh) { recipient = fresh; kind = "initial"; }
  }

  if (!recipient) {
    // Check if any follow-ups are still pending in the future — if so, keep running
    const { count: upcoming } = await db
      .from("recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("status", "sent")
      .not("next_follow_up_at", "is", null);
    const { count: pendingRetries } = await db
      .from("recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("status", "pending");
    if ((upcoming ?? 0) === 0 && (pendingRetries ?? 0) === 0) {
      await db.from("campaigns").update({ status: "done" }).eq("id", campaign.id);
      return NextResponse.json({ status: "campaign_finished", campaign: campaign.name });
    }
    return NextResponse.json({ status: "waiting", upcoming_follow_ups: upcoming ?? 0 });
  }

  // skip if globally unsubscribed
  const { data: unsub } = await db
    .from("unsubscribes")
    .select("email")
    .eq("email", recipient.email)
    .maybeSingle();
  if (unsub) {
    await db.from("recipients").update({ status: "unsubscribed", next_follow_up_at: null }).eq("id", recipient.id);
    return NextResponse.json({ status: "skipped_unsubscribed", to: recipient.email });
  }

  // ATOMIC CLAIM — optimistic compare-and-set on last_sent_at so only one
  // concurrent tick wins and sends this recipient. Prevents duplicate-sends
  // if pg_cron + manual curl fire close together or SMTP is slow.
  {
    const prior = recipient.last_sent_at;
    let q = db
      .from("recipients")
      .update({ last_sent_at: nowIso })
      .eq("id", recipient.id)
      .eq("status", "pending");
    if (kind === "follow_up") {
      q = db
        .from("recipients")
        .update({ last_sent_at: nowIso })
        .eq("id", recipient.id)
        .eq("status", "sent")
        .eq("follow_up_count", recipient.follow_up_count);
    }
    // CAS on last_sent_at value
    q = prior === null ? q.is("last_sent_at", null) : q.eq("last_sent_at", prior);
    const { data: claim } = await q.select("id").maybeSingle();
    if (!claim) {
      return NextResponse.json({ status: "claim_lost", to: recipient.email, kind });
    }
  }

  // ---- render ----
  const vars = { ...(recipient.vars ?? {}), Name: recipient.name, Company: recipient.company };
  // For the "Re:" prefix decision, look at the original campaign subject (the
  // one the thread was opened with). A step-level subject override doesn't
  // change whether this is a reply to the original thread.
  const threadSubject = campaign.subject;
  const rawSubject = kind === "follow_up" && step.subject ? step.subject : campaign.subject;
  const subject =
    kind === "follow_up" && recipient.message_id && !/^re:\s/i.test(threadSubject)
      ? `Re: ${rawSubject.replace(/^re:\s*/i, "")}`
      : rawSubject;
  const templateSrc = kind === "follow_up" ? step.template : campaign.template;
  const bodyHtml = render(templateSrc, vars, { escapeForHtml: true });
  const bodyText = render(templateSrc, vars);

  const base = appUrl();
  const unsubUrl = campaign.unsubscribe_enabled ? `${base}/u/${signToken("u", recipient.id)}` : undefined;
  const openPixelUrl = campaign.tracking_enabled
    ? `${base}/api/t/o/${signToken("o", recipient.id)}.gif`
    : undefined;
  const wrapUrl = campaign.tracking_enabled
    ? (url: string) => `${base}/api/t/c/${signToken("c", recipient.id)}?u=${encodeURIComponent(url)}`
    : undefined;

  const html = toHtml(bodyHtml, { wrapUrl, openPixelUrl, unsubscribeUrl: unsubUrl });
  const text = toPlain(bodyText, { unsubscribeUrl: unsubUrl });

  // ---- attachments (up to 5 files per campaign) ----
  let attachments: { filename: string; content: Buffer }[] | undefined;
  const paths: string[] = campaign.attachment_paths ?? [];
  const names: string[] = campaign.attachment_filenames ?? [];
  if (paths.length > 0) {
    const loaded = await Promise.all(
      paths.map((p, i) => downloadAttachment(db, p, names[i] ?? "attachment"))
    );
    const ok = loaded.filter((x): x is { filename: string; content: Buffer } => !!x);
    if (ok.length > 0) attachments = ok;
  } else if (campaign.attachment_path && campaign.attachment_filename) {
    // legacy single-attachment fallback (for campaigns not yet migrated)
    const att = await downloadAttachment(db, campaign.attachment_path, campaign.attachment_filename);
    if (att) attachments = [att];
  }

  // ---- headers ----
  const headers: Record<string, string> = {};
  if (unsubUrl) {
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // Thread follow-ups as replies to the initial message so Gmail groups them.
  // RFC 5322 requires Message-IDs to be angle-bracket wrapped.
  if (kind === "follow_up" && recipient.message_id) {
    const normalized = recipient.message_id.startsWith("<")
      ? recipient.message_id
      : `<${recipient.message_id}>`;
    headers["In-Reply-To"] = normalized;
    headers["References"] = normalized;
  }

  // ---- send ----
  let sentMessageId: string | null = null;
  try {
    sentMessageId = await sendMail({ to: recipient.email, subject, text, html, sender, attachments, headers });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // retry logic (applies to initial + retry kinds; follow-up failures just log and move on)
    if (kind !== "follow_up" && campaign.retry_enabled && recipient.retry_count < campaign.max_retries) {
      const nextRetry = new Date(now.getTime() + 30 * 60 * 1000 * (recipient.retry_count + 1));
      await db
        .from("recipients")
        .update({
          retry_count: recipient.retry_count + 1,
          next_retry_at: nextRetry.toISOString(),
          error: msg,
        })
        .eq("id", recipient.id);
      return NextResponse.json({
        status: "send_failed_will_retry",
        to: recipient.email,
        retry_count: recipient.retry_count + 1,
        next_retry_at: nextRetry.toISOString(),
      }, { status: 200 });
    }
    // no retry — mark failed
    await db
      .from("recipients")
      .update({
        status: kind === "follow_up" ? recipient.status : "failed",
        next_follow_up_at: kind === "follow_up" ? null : recipient.next_follow_up_at,
        error: msg,
      })
      .eq("id", recipient.id);
    return NextResponse.json({ status: "send_failed", to: recipient.email, kind, error: msg }, { status: 200 });
  }

  // ---- success updates ----
  if (kind === "initial" || kind === "retry") {
    const update: Record<string, unknown> = {
      status: "sent",
      sent_at: nowIso,
      last_sent_at: nowIso,
      error: null,
      next_retry_at: null,
    };
    // Capture Message-ID so follow-ups can thread to it (store angle-bracketed)
    if (sentMessageId && !recipient.message_id) {
      update.message_id = sentMessageId.startsWith("<") ? sentMessageId : `<${sentMessageId}>`;
    }
    // schedule first follow-up if enabled
    if (campaign.follow_ups_enabled) {
      const { data: firstStep } = await db
        .from("follow_up_steps")
        .select("delay_days")
        .eq("campaign_id", campaign.id)
        .eq("step_number", 1)
        .maybeSingle();
      if (firstStep) {
        const next = new Date(now.getTime() + firstStep.delay_days * 86400 * 1000);
        update.next_follow_up_at = next.toISOString();
      }
    }
    await db.from("recipients").update(update).eq("id", recipient.id);
  } else if (kind === "follow_up") {
    const nextStepNumber = recipient.follow_up_count + 2; // already sent this one, look for the next
    const { data: nextStep } = await db
      .from("follow_up_steps")
      .select("delay_days")
      .eq("campaign_id", campaign.id)
      .eq("step_number", nextStepNumber)
      .maybeSingle();
    const nextTs = nextStep ? new Date(now.getTime() + nextStep.delay_days * 86400 * 1000).toISOString() : null;
    await db
      .from("recipients")
      .update({
        follow_up_count: recipient.follow_up_count + 1,
        last_sent_at: nowIso,
        next_follow_up_at: nextTs,
        error: null,
      })
      .eq("id", recipient.id);
  }

  await db.from("send_log").insert({
    campaign_id: campaign.id,
    recipient_id: recipient.id,
    kind,
    step_number: kind === "follow_up" ? step.step_number : null,
    sent_at: nowIso,
    day: today,
  });

  return NextResponse.json({
    status: "sent",
    kind,
    to: recipient.email,
    campaign: campaign.name,
    sent_today: (todayCount ?? 0) + 1,
  });
}
