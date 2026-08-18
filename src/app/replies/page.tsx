"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import ReplyDrawer, { type ReplyItem } from "@/components/ReplyDrawer";
import { useConfirm } from "@/components/useConfirm";

export default function RepliesPage() {
  const [replies, setReplies] = useState<ReplyItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState<ReplyItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [replyCheckEnabled, setReplyCheckEnabled] = useState<boolean | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  async function load() {
    const r = await fetch("/api/replies", { cache: "no-store" });
    const d = await r.json();
    setReplies(d.replies ?? []);
  }

  async function loadFlag() {
    const r = await fetch("/api/settings/reply-check", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    setReplyCheckEnabled(!!d.enabled);
  }

  async function toggleFlag() {
    if (replyCheckEnabled === null) return;
    const next = !replyCheckEnabled;
    if (next) {
      const ok = await confirm({
        title: "Enable reply checking?",
        description: "This polls Gmail IMAP every 15 min and uses more Vercel resources. You can turn it off again anytime.",
        confirmLabel: "Enable",
      });
      if (!ok) return;
    }
    setTogglePending(true);
    setErr(null);
    try {
      const r = await fetch("/api/settings/reply-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        setErr("Failed to update setting.");
        return;
      }
      const d = await r.json();
      setReplyCheckEnabled(!!d.enabled);
    } finally {
      setTogglePending(false);
    }
  }

  useEffect(() => { load(); loadFlag(); }, []);

  async function reload() {
    setRunning(true);
    await load();
    setRunning(false);
  }

  async function deleteReply(id: string) {
    const ok = await confirm({
      title: "Delete this reply?",
      description: "This only removes it from the list — the recipient stays marked as replied.",
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(id);
    setErr(null);
    try {
      const r = await fetch(`/api/replies/${id}`, { method: "DELETE" });
      if (!r.ok) {
        setErr("Failed to delete reply.");
        return;
      }
      setReplies((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
      if (active?.id === id) setActive(null);
    } finally {
      setDeletingId(null);
    }
  }

  const filtered = useMemo(() => {
    if (!replies) return null;
    const q = query.trim().toLowerCase();
    if (!q) return replies;
    return replies.filter((r) => {
      const hay = [
        r.recipient?.name,
        r.recipient?.company,
        r.from_email,
        r.subject,
        r.snippet,
        r.campaign?.name,
      ]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join("  ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [replies, query]);

  const totalCount = replies?.length ?? 0;
  const filteredCount = filtered?.length ?? 0;
  const isFiltering = query.trim().length > 0;

  return (
    <AppShell>
      <div className="page">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight">Replies</h1>
            <p className="text-[13px] text-ink-500 mt-1">
              {replies === null
                ? "Loading…"
                : isFiltering
                  ? `${filteredCount} of ${totalCount} inbound messages`
                  : `${totalCount} inbound messages from recipients`}
            </p>
          </div>
          <button type="button" onClick={reload} disabled={running} className="btn-ghost text-[13px]">
            {running ? "Loading…" : "Reload"}
          </button>
        </div>

        {err && (
          <div className="flex items-center justify-between gap-3 bg-red-50 text-red-700 text-[13px] px-3 py-2 rounded-md mb-4">
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="btn-quiet text-[12px] shrink-0">Dismiss</button>
          </div>
        )}

        {replyCheckEnabled !== null && (
          <div className={`mb-4 px-4 py-3 rounded-lg border flex items-center justify-between gap-4 ${replyCheckEnabled ? "border-ink-200 bg-paper" : "border-amber-300 bg-amber-50"}`}>
            <div className="min-w-0 flex-1">
              <div className={`text-[13px] font-semibold ${replyCheckEnabled ? "text-ink" : "text-amber-900"}`}>
                Reply checking is {replyCheckEnabled ? "ON" : "OFF"}
              </div>
              <div className={`text-[12px] mt-0.5 ${replyCheckEnabled ? "text-ink-500" : "text-amber-800"}`}>
                {replyCheckEnabled
                  ? "Gmail IMAP is polled every 15 min. Replies appear here within minutes of arriving."
                  : "Mass mailing still works — only inbound polling is paused. Turn on to start ingesting replies."}
              </div>
            </div>
            <button
              type="button"
              onClick={toggleFlag}
              disabled={togglePending}
              className={`shrink-0 text-[13px] px-3 py-1.5 rounded border transition-colors ${replyCheckEnabled ? "border-ink-300 hover:bg-hover" : "border-amber-900 bg-amber-900 text-amber-50 hover:opacity-90"}`}
            >
              {togglePending ? "…" : replyCheckEnabled ? "Turn off" : "Turn on"}
            </button>
          </div>
        )}

        {replies && replies.length > 0 && (
          <div className="mb-4 relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, company, subject, or campaign…"
              className="field-boxed w-full !pl-9 !pr-9 text-[13px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-ink-500 hover:bg-hover hover:text-ink transition-colors"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M6 18L18 6" /></svg>
              </button>
            )}
          </div>
        )}

        {replies === null && <p className="text-[13px] text-ink-500">Loading…</p>}

        {replies?.length === 0 && (
          <div className="text-center py-16 border border-dashed border-ink-200 rounded-lg">
            <div className="text-[14px] font-medium text-ink mb-1">No replies yet</div>
            <p className="text-[13px] text-ink-500 max-w-md mx-auto">
              Replies appear here within 5 min of landing in Gmail. Make sure the Supabase cron is wired up.
            </p>
          </div>
        )}

        {replies && replies.length > 0 && filteredCount === 0 && (
          <div className="text-center py-12 border border-dashed border-ink-200 rounded-lg">
            <div className="text-[14px] font-medium text-ink mb-1">No matches</div>
            <p className="text-[13px] text-ink-500">
              Nothing matches <span className="font-mono text-ink">&ldquo;{query}&rdquo;</span>.
            </p>
          </div>
        )}

        {filtered && filtered.length > 0 && (
          <div className="sheet overflow-hidden">
            {filtered.map((r) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setActive(r)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(r); } }}
                className="group w-full text-left flex items-start gap-4 px-4 py-3 border-b border-ink-100 last:border-b-0 hover:bg-hover transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium truncate">
                      {r.recipient?.name ?? r.from_email}
                    </span>
                    {r.recipient?.company && (
                      <span className="text-[13px] text-ink-500">@ {r.recipient.company}</span>
                    )}
                    {r.campaign && (
                      <Link
                        href={`/campaigns/${r.campaign.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="pill-paper hover:bg-ink hover:text-paper transition-colors"
                      >
                        {r.campaign.name}
                      </Link>
                    )}
                  </div>
                  <div className="text-[13px] text-ink-700 mt-0.5 truncate" title={r.subject ?? ""}>
                    {r.subject ?? <span className="italic text-ink-400">(no subject)</span>}
                  </div>
                  {r.snippet && (
                    <div className="text-[12px] text-ink-500 mt-0.5 line-clamp-1">{r.snippet}</div>
                  )}
                  <div className="text-[11px] font-mono text-ink-400 mt-0.5">{r.from_email}</div>
                </div>
                <div className="flex items-center gap-2 pt-1 shrink-0">
                  <div className="text-[12px] text-ink-500 whitespace-nowrap">
                    {r.received_at
                      ? new Date(r.received_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                      : new Date(r.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short" })}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteReply(r.id); }}
                    disabled={deletingId === r.id}
                    aria-label="Delete reply"
                    title="Delete reply"
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 w-7 h-7 flex items-center justify-center rounded text-ink-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 transition-all"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <ReplyDrawer reply={active} onClose={() => setActive(null)} onSent={load} />
      </div>
      {ConfirmDialog}
    </AppShell>
  );
}
