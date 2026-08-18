"use client";

import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

export type ReplyItem = {
  id: string;
  from_email: string;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  created_at: string;
  recipient: { id: string; name: string; company: string } | null;
  campaign: { id: string; name: string } | null;
};

function sanitizeHtml(html: string): string {
  // Reply bodies come from arbitrary external senders (cold-outreach replies),
  // not a trusted inbox, so this needs a real sanitizer rather than a regex.
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["iframe", "object", "embed", "form", "input", "svg", "math"],
    FORBID_ATTR: ["srcdoc"],
  });
}

export default function ReplyDrawer({
  reply,
  onClose,
  onSent,
}: {
  reply: ReplyItem | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [instructions, setInstructions] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const replyId = reply?.id ?? null;

  // Reset the composer whenever a different reply is opened.
  useEffect(() => {
    setDraft("");
    setInstructions("");
    setGenerating(false);
    setSending(false);
    setSent(false);
    setErr(null);
  }, [replyId]);

  useEffect(() => {
    if (!reply) return;
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [reply, onClose]);

  async function generate() {
    if (!replyId) return;
    setGenerating(true);
    setErr(null);
    try {
      const r = await fetch(`/api/replies/${replyId}/ai-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: instructions.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(typeof d.error === "string" ? d.error : `Failed (HTTP ${r.status}).`);
        return;
      }
      setDraft(d.draft ?? "");
    } finally {
      setGenerating(false);
    }
  }

  async function send() {
    if (!replyId || !draft.trim()) return;
    setSending(true);
    setErr(null);
    try {
      const r = await fetch(`/api/replies/${replyId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: draft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(typeof d.error === "string" ? d.error : `Failed (HTTP ${r.status}).`);
        return;
      }
      setSent(true);
      onSent?.();
    } finally {
      setSending(false);
    }
  }

  if (!reply) return null;

  const when = reply.received_at ?? reply.created_at;
  const whenFmt = new Date(when).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/30" />
      <aside
        className="absolute top-0 right-0 bottom-0 w-full max-w-2xl bg-paper border-l border-ink-200 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-paper border-b border-ink-200 px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-ink-500 uppercase tracking-wider">Reply</div>
            <div className="text-[16px] font-semibold mt-0.5 truncate">
              {reply.subject || <span className="italic text-ink-400">(no subject)</span>}
            </div>
            <div className="flex items-center gap-2 text-[13px] text-ink-600 mt-1 flex-wrap">
              <span className="font-medium">{reply.recipient?.name ?? reply.from_email}</span>
              {reply.recipient?.company && <span className="text-ink-400">· {reply.recipient.company}</span>}
            </div>
            <div className="text-[11px] font-mono text-ink-500 truncate mt-0.5">{reply.from_email}</div>
            <div className="text-[11px] text-ink-500 mt-1">{whenFmt}</div>
          </div>
          <button type="button" onClick={onClose} className="btn-quiet p-1.5 shrink-0" aria-label="Close">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M6 18L18 6" /></svg>
          </button>
        </div>

        <div className="px-5 py-5">
          {reply.body_html ? (
            <div
              className="email-preview bg-paper text-ink text-[14px] leading-[1.55]"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(reply.body_html) }}
            />
          ) : reply.body_text ? (
            <pre className="whitespace-pre-wrap font-sans text-[14px] leading-[1.55] text-ink">{reply.body_text}</pre>
          ) : reply.snippet ? (
            <div className="text-[14px] text-ink-700 leading-[1.55]">{reply.snippet}</div>
          ) : (
            <div className="text-[13px] text-ink-500">No body captured for this message.</div>
          )}
        </div>

        <div className="border-t border-ink-200 px-5 py-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-[11px] font-medium text-ink-500 uppercase tracking-wider">AI reply</div>
            <button
              type="button"
              onClick={generate}
              disabled={generating || sending}
              className="btn-quiet text-[12px]"
            >
              {generating ? "Generating…" : draft ? "Regenerate" : "Generate AI reply"}
            </button>
          </div>

          <input
            type="text"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Optional steer: e.g. 'offer a 15-min call next week', 'be brief and friendly'"
            className="field-boxed w-full text-[12px] mb-3"
            disabled={generating || sending}
          />

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            placeholder="Generate a draft above, or write your reply here. You can edit before sending."
            className="field-boxed w-full text-[14px] leading-[1.55] resize-y"
            disabled={sending}
          />

          {err && (
            <div className="mt-3 bg-red-50 text-red-700 text-[12px] px-3 py-2 rounded-md">{err}</div>
          )}
          {sent && (
            <div className="mt-3 bg-green-50 text-green-700 text-[12px] px-3 py-2 rounded-md">
              Reply sent to {reply.from_email}.
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mt-3">
            <p className="text-[11px] text-ink-500">
              Sends from this campaign&apos;s sender, threaded into the conversation. Review before sending.
            </p>
            <button
              type="button"
              onClick={send}
              disabled={sending || generating || !draft.trim() || sent}
              className="btn-accent text-[13px] shrink-0"
            >
              {sending ? "Sending…" : sent ? "Sent" : "Send reply"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
