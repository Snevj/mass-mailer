"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useConfirm } from "@/components/useConfirm";

type UnsubRow = { email: string; campaign_id: string | null; created_at: string };

export default function UnsubscribesPage() {
  const [rows, setRows] = useState<UnsubRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  async function load(q?: string) {
    const r = await fetch(`/api/unsubscribes${q ? `?q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" });
    if (!r.ok) { setErr("Couldn't load the unsubscribe list."); return; }
    const d = await r.json();
    setRows(d.unsubscribes ?? []);
  }

  useEffect(() => {
    const t = setTimeout(() => load(query), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    if (!addEmail.trim()) return;
    setAdding(true);
    setErr(null);
    try {
      const r = await fetch("/api/unsubscribes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addEmail.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(typeof d.error === "string" ? d.error : "Failed to add."); return; }
      setAddEmail("");
      load(query);
    } finally {
      setAdding(false);
    }
  }

  async function removeOne(email: string) {
    const ok = await confirm({
      title: "Remove from unsubscribe list?",
      description: `${email} will become eligible to receive campaigns again.`,
      danger: true,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const r = await fetch(`/api/unsubscribes?email=${encodeURIComponent(email)}`, { method: "DELETE" });
    if (r.ok) load(query);
    else setErr("Failed to remove.");
  }

  return (
    <AppShell>
      <div className="page">
        <div className="mb-6">
          <h1 className="text-[28px] font-bold tracking-tight">Unsubscribes</h1>
          <p className="text-[13px] text-ink-500 mt-1">
            {rows ? `${rows.length} suppressed address${rows.length === 1 ? "" : "es"}` : "Loading…"} · every campaign skips these automatically.
          </p>
        </div>

        {err && (
          <div className="flex items-center justify-between gap-3 bg-red-50 text-red-700 text-[13px] px-3 py-2 rounded-md mb-4">
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="btn-quiet text-[12px] shrink-0">Dismiss</button>
          </div>
        )}

        <form onSubmit={addOne} className="sheet p-4 mb-6 flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="label-cap">Add an address manually</label>
            <input
              type="email"
              className="field-boxed"
              placeholder="someone@example.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={adding} className="btn-accent shrink-0">
            {adding ? "Adding…" : "Add"}
          </button>
        </form>

        <div className="mb-4 relative max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            className="field-boxed pl-9"
            placeholder="Search unsubscribed emails…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {rows === null && <div className="text-[13px] text-ink-500 py-8">Loading…</div>}

        {rows && rows.length === 0 && (
          <div className="text-center py-16 border border-dashed border-ink-200 rounded-lg">
            <div className="text-[14px] font-medium text-ink mb-1">
              {query ? "No matches." : "No one has unsubscribed yet."}
            </div>
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="sheet overflow-hidden">
            <div className="hidden md:grid grid-cols-[1fr,auto,28px] gap-4 px-4 py-2.5 border-b border-ink-200 text-[12px] font-medium text-ink-500">
              <span>Email</span>
              <span className="text-right">Added</span>
              <span />
            </div>
            {rows.map((r) => (
              <div key={r.email} className="grid grid-cols-1 md:grid-cols-[1fr,auto,28px] gap-2 md:gap-4 items-center px-4 py-2.5 text-[13px] border-b border-ink-100 last:border-b-0">
                <span className="font-mono text-[12px] truncate">{r.email}</span>
                <span className="text-[11px] text-ink-500 md:text-right">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => removeOne(r.email)}
                  className="text-ink-400 hover:text-red-600 p-1 -m-1 justify-self-end"
                  aria-label={`Remove ${r.email}`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {ConfirmDialog}
    </AppShell>
  );
}
