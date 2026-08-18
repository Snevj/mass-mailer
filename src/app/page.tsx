"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useConfirm } from "@/components/useConfirm";

type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  status: "draft" | "running" | "paused" | "done";
  daily_cap: number;
  total: number;
  sent: number;
  failed: number;
  updated_at: string;
  created_at: string;
};

function statusPill(s: CampaignRow["status"]) {
  const map = { running: "pill-live", paused: "pill-pause", done: "pill-done", draft: "pill-draft" } as const;
  const dot = { running: "dot-live", paused: "dot-pause", done: "dot-done", draft: "dot-draft" } as const;
  return (
    <span className={map[s]}>
      <span className={dot[s]} />
      {s}
    </span>
  );
}

function relative(dt: string) {
  const diff = Date.now() - new Date(dt).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dt).toLocaleDateString();
}

export default function Home() {
  const router = useRouter();
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<"all" | "running" | "draft" | "done">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  async function load() {
    try {
      const r = await fetch(`/api/campaigns${showArchived ? "?archived=1" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setRows(data.campaigns ?? []);
      setLoadErr(null);
    } catch {
      setLoadErr("Couldn't load campaigns.");
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  const filtered = (rows ?? []).filter((r) => filter === "all" || r.status === filter);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((c) => c.id))
    );
  }

  async function bulkDelete() {
    const n = selected.size;
    const ok = await confirm({
      title: `Delete ${n} campaign${n === 1 ? "" : "s"}?`,
      description: "This permanently deletes the selected campaigns and all of their recipients. This cannot be undone.",
      danger: true,
      confirmLabel: `Delete ${n}`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => fetch(`/api/campaigns/${id}`, { method: "DELETE" })));
      setSelected(new Set());
      load();
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <AppShell>
      <div className="page">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight">Campaigns</h1>
            <p className="text-[13px] text-ink-500 mt-1">
              {rows ? `${rows.length} ${rows.length === 1 ? "campaign" : "campaigns"}` : "Loading…"}
              {rows && ` · ${rows.filter((r) => r.status === "running").length} running`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="btn-quiet text-[13px]"
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
            <Link href="/campaigns/new" className="btn-accent">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              New
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-1 mb-4">
          {(["all", "running", "draft", "done"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[13px] px-2.5 py-1 rounded transition-colors capitalize cursor-pointer ${
                filter === f ? "bg-hover text-ink font-medium" : "text-ink-500 hover:bg-hover hover:text-ink"
              }`}
            >
              {f}
              {rows && (
                <span className="ml-1.5 text-ink-400">
                  {f === "all" ? rows.length : rows.filter((r) => r.status === f).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 bg-surface border border-ink-200 text-[13px] px-4 py-2.5 rounded-md mb-4">
            <span>{selected.size} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setSelected(new Set())} className="btn-quiet text-[12px]">Clear</button>
              <button onClick={bulkDelete} disabled={bulkDeleting} className="btn-danger text-[12px]">
                {bulkDeleting ? "Deleting…" : "Delete selected"}
              </button>
            </div>
          </div>
        )}

        {loadErr && (
          <div className="flex items-center justify-between gap-3 bg-red-50 text-red-700 text-[13px] px-3 py-2 rounded-md mb-4">
            <span>{loadErr}</span>
            <button onClick={() => load()} className="btn-quiet text-[12px] shrink-0">Retry</button>
          </div>
        )}

        {rows === null && !loadErr && (
          <div className="text-[13px] text-ink-500 py-8">Loading…</div>
        )}

        {rows?.length === 0 && (
          <div className="text-center py-16 border border-dashed border-ink-200 rounded-lg">
            <div className="text-[14px] font-medium text-ink mb-1">No campaigns yet</div>
            <p className="text-[13px] text-ink-500 mb-4">Create your first campaign to get started.</p>
            <Link href="/campaigns/new" className="btn-accent inline-flex">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              New campaign
            </Link>
          </div>
        )}

        {rows && rows.length > 0 && filtered.length === 0 && (
          <div className="text-center py-12 text-[13px] text-ink-500">No campaigns match this filter.</div>
        )}

        {filtered.length > 0 && (
          <div className="sheet overflow-hidden">
            {/* desktop table header */}
            <div className="hidden md:grid grid-cols-[24px,1fr,auto,120px,100px] gap-4 px-4 py-2.5 border-b border-ink-200 text-[12px] font-medium text-ink-500 items-center">
              <input
                type="checkbox"
                className="accent-ink"
                checked={selected.size > 0 && selected.size === filtered.length}
                onChange={toggleAll}
                aria-label="Select all"
              />
              <span>Name</span>
              <span className="text-right">Progress</span>
              <span>Status</span>
              <span className="text-right">Updated</span>
            </div>
            {filtered.map((c) => {
              const pct = c.total ? Math.round((c.sent / c.total) * 100) : 0;
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/campaigns/${c.id}`)}
                  onKeyDown={(e) => { if (e.key === "Enter") router.push(`/campaigns/${c.id}`); }}
                  className="block md:grid md:grid-cols-[24px,1fr,auto,120px,100px] md:gap-4 md:items-center px-4 py-3 border-b border-ink-100 last:border-b-0 hover:bg-hover transition-colors cursor-pointer"
                >
                  <div className="hidden md:block" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="accent-ink"
                      checked={selected.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      aria-label={`Select ${c.name}`}
                    />
                  </div>
                  {/* mobile: stacked; desktop: first column */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 md:block">
                      <input
                        type="checkbox"
                        className="accent-ink md:hidden shrink-0"
                        checked={selected.has(c.id)}
                        onChange={() => toggleOne(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${c.name}`}
                      />
                      <div className="text-[14px] font-medium text-ink truncate flex-1 md:flex-initial">{c.name}</div>
                      <span className="md:hidden shrink-0">{statusPill(c.status)}</span>
                    </div>
                    <div className="text-[12px] text-ink-500 truncate mt-0.5">{c.subject}</div>
                    {/* mobile-only progress bar under name */}
                    <div className="md:hidden flex items-center gap-2 mt-2">
                      <div className="flex-1 h-1 bg-ink-100 rounded-full overflow-hidden">
                        <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] text-ink-500 font-mono tabular-nums whitespace-nowrap">
                        {c.sent} / {c.total} · {pct}%
                      </span>
                    </div>
                    <div className="md:hidden text-[11px] text-ink-500 mt-1">Updated {relative(c.updated_at)}</div>
                  </div>
                  {/* desktop-only columns */}
                  <div className="hidden md:block text-right">
                    <div className="text-[13px] font-mono">{c.sent} / {c.total}</div>
                    <div className="flex items-center gap-1.5 justify-end mt-1">
                      <div className="w-16 h-1 bg-ink-100 rounded-full overflow-hidden">
                        <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] text-ink-400 font-mono">{pct}%</span>
                    </div>
                  </div>
                  <div className="hidden md:flex items-center">{statusPill(c.status)}</div>
                  <div className="hidden md:block text-[12px] text-ink-500 text-right">{relative(c.updated_at)}</div>
                </div>
              );
            })}
          </div>
        )}
        {ConfirmDialog}
      </div>
    </AppShell>
  );
}
