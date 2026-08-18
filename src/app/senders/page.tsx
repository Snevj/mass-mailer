"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useConfirm } from "@/components/useConfirm";

type Provider = "gmail" | "outlook" | "microsoft_graph";

type Sender = {
  id: string;
  label: string;
  email: string;
  from_name: string | null;
  is_default: boolean;
  warmup_enabled: boolean;
  warmup_started_at: string | null;
  provider: Provider;
  ms_tenant_id: string | null;
  ms_client_id: string | null;
  created_at: string;
};

const PROVIDER_LABEL: Record<Provider, string> = { gmail: "Gmail", outlook: "Outlook", microsoft_graph: "Microsoft 365" };

function warmupStatus(s: Sender) {
  if (!s.warmup_enabled || !s.warmup_started_at) return null;
  const days = Math.floor((Date.now() - new Date(s.warmup_started_at).getTime()) / 86_400_000);
  const ramp = [10, 20, 40, 60, 100, 150, 200, 250, 300, 350, 400, 400, 400, 400];
  if (days >= ramp.length) return { done: true, day: ramp.length, cap: null as number | null };
  return { done: false, day: days + 1, cap: ramp[Math.max(0, days)] };
}

export default function SendersPage() {
  const [senders, setSenders] = useState<Sender[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", email: "", provider: "gmail" as Provider, app_password: "", ms_tenant_id: "", ms_client_id: "", from_name: "", is_default: false, warmup_enabled: false });
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  async function load() {
    const r = await fetch("/api/senders", { cache: "no-store" });
    const data = await r.json();
    setSenders(data.senders ?? []);
  }
  useEffect(() => { load(); }, []);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    const r = await fetch("/api/senders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: form.label,
        email: form.email.toLowerCase().trim(),
        provider: form.provider,
        app_password: form.app_password,
        ms_tenant_id: form.ms_tenant_id.trim() || null,
        ms_client_id: form.ms_client_id.trim() || null,
        from_name: form.from_name || null,
        is_default: form.is_default,
        warmup_enabled: form.warmup_enabled,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (typeof j.error === "string") setErr(j.error);
      else if (j.error && typeof j.error === "object") setErr(JSON.stringify(j.error));
      else setErr(`Failed (HTTP ${r.status}).`);
      return;
    }
    setForm({ label: "", email: "", provider: "gmail", app_password: "", ms_tenant_id: "", ms_client_id: "", from_name: "", is_default: false, warmup_enabled: false });
    setAdding(false);
    await load();
  }

  async function setDefault(id: string) {
    await fetch(`/api/senders/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });
    await load();
  }

  async function remove(id: string, label: string) {
    const ok = await confirm({
      title: "Delete this sender?",
      description: `"${label}" will be removed. Campaigns using it will fall back to the env-var Gmail sender.`,
      danger: true,
      confirmLabel: "Delete sender",
    });
    if (!ok) return;
    await fetch(`/api/senders/${id}`, { method: "DELETE" });
    await load();
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ label: string; from_name: string }>({ label: "", from_name: "" });
  const [editSaving, setEditSaving] = useState(false);

  function startEdit(s: Sender) {
    setEditingId(s.id);
    setEditForm({ label: s.label, from_name: s.from_name ?? "" });
  }
  async function saveEdit(id: string) {
    setEditSaving(true);
    await fetch(`/api/senders/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: editForm.label, from_name: editForm.from_name || null }),
    });
    setEditSaving(false);
    setEditingId(null);
    await load();
  }

  return (
    <AppShell>
      <div className="page-narrow">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight">Senders</h1>
            <p className="text-[13px] text-ink-500 mt-1">Gmail &amp; Outlook accounts authorized to send campaigns.</p>
          </div>
          {!adding && <button className="btn-accent" onClick={() => setAdding(true)}>+ Add sender</button>}
        </div>

        {adding && (
          <form onSubmit={onAdd} className="sheet p-5 mb-6">
            <h2 className="text-[16px] font-semibold mb-1">New sender</h2>
            <p className="text-[13px] text-ink-500 mb-5">
              {form.provider === "gmail" && (
                <>
                  Use an <b>app password</b>, not your Gmail login. Generate at{" "}
                  <a className="btn-link" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                    myaccount.google.com/apppasswords
                  </a>
                  . 2FA must be on.
                </>
              )}
              {form.provider === "outlook" && (
                <>
                  Use an <b>app password</b>, not your Outlook login. Create one at{" "}
                  <a className="btn-link" href="https://account.microsoft.com/security" target="_blank" rel="noreferrer">
                    account.microsoft.com/security
                  </a>
                  . 2-step verification must be on. Best for personal Outlook.com mailboxes.
                </>
              )}
              {form.provider === "microsoft_graph" && (
                <>
                  For <b>Microsoft 365 business</b> mailboxes. Your IT admin registers an app in{" "}
                  <a className="btn-link" href="https://entra.microsoft.com" target="_blank" rel="noreferrer">
                    Microsoft Entra
                  </a>{" "}
                  with the Graph <b>Mail.Send</b> application permission (admin consent granted), then gives you the
                  three values below. No password or MFA needed.
                </>
              )}
            </p>

            <div className="mb-4">
              <label className="label-cap">Provider</label>
              <div className="flex gap-2">
                {(["gmail", "outlook", "microsoft_graph"] as Provider[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm({ ...form, provider: p })}
                    className={`flex-1 px-3 py-2 rounded-md border text-[13px] font-medium transition-colors ${
                      form.provider === p
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-ink-200 text-ink-600 hover:bg-hover"
                    }`}
                  >
                    {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label-cap">Label</label>
                <input className="field-boxed" placeholder="Personal · Work" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
              </div>
              <div>
                <label className="label-cap">Display name</label>
                <input className="field-boxed" placeholder="Nishant Raj" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
              </div>
              <div className={form.provider === "microsoft_graph" ? "md:col-span-2" : ""}>
                <label className="label-cap">
                  {form.provider === "gmail" ? "Gmail address" : form.provider === "outlook" ? "Outlook address" : "Microsoft 365 mailbox"}
                </label>
                <input
                  className="field-boxed"
                  type="email"
                  placeholder={form.provider === "gmail" ? "you@gmail.com" : form.provider === "outlook" ? "you@outlook.com" : "you@company.com"}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </div>

              {form.provider !== "microsoft_graph" && (
                <div>
                  <label className="label-cap">App password</label>
                  <div className="flex gap-2">
                    <input
                      className="field-boxed font-mono flex-1"
                      type={showSecret ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="xxxx xxxx xxxx xxxx"
                      value={form.app_password}
                      onChange={(e) => setForm({ ...form, app_password: e.target.value })}
                      required
                    />
                    <button type="button" onClick={() => setShowSecret((v) => !v)} className="btn-ghost text-[12px] shrink-0">
                      {showSecret ? "Hide" : "Show"}
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-500 mt-1.5">
                    {form.provider === "gmail"
                      ? "16 lowercase letters Google generates — not your login password."
                      : "The app password from your Microsoft account — not your login password."}
                  </p>
                </div>
              )}

              {form.provider === "microsoft_graph" && (
                <>
                  <div>
                    <label className="label-cap">Directory (tenant) ID</label>
                    <input className="field-boxed font-mono" placeholder="00000000-0000-0000-0000-000000000000" value={form.ms_tenant_id} onChange={(e) => setForm({ ...form, ms_tenant_id: e.target.value })} required />
                  </div>
                  <div>
                    <label className="label-cap">Application (client) ID</label>
                    <input className="field-boxed font-mono" placeholder="00000000-0000-0000-0000-000000000000" value={form.ms_client_id} onChange={(e) => setForm({ ...form, ms_client_id: e.target.value })} required />
                  </div>
                  <div className="md:col-span-2">
                    <label className="label-cap">Client secret</label>
                    <div className="flex gap-2">
                      <input
                        className="field-boxed font-mono flex-1"
                        type={showSecret ? "text" : "password"}
                        autoComplete="new-password"
                        placeholder="Secret Value from Certificates & secrets"
                        value={form.app_password}
                        onChange={(e) => setForm({ ...form, app_password: e.target.value })}
                        required
                      />
                      <button type="button" onClick={() => setShowSecret((v) => !v)} className="btn-ghost text-[12px] shrink-0">
                        {showSecret ? "Hide" : "Show"}
                      </button>
                    </div>
                    <p className="text-[11px] text-ink-500 mt-1.5">Paste the secret <b>Value</b> (not the Secret ID). Shown only once when IT creates it.</p>
                  </div>
                </>
              )}
            </div>

            <div className="mt-5 space-y-2.5">
              <label className="flex items-center gap-2 text-[13px] cursor-pointer w-fit">
                <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="w-4 h-4 accent-accent" />
                <span>Make this the default sender for new campaigns</span>
              </label>
              <label className="flex items-start gap-2 text-[13px] cursor-pointer">
                <input type="checkbox" checked={form.warmup_enabled} onChange={(e) => setForm({ ...form, warmup_enabled: e.target.checked })} className="w-4 h-4 mt-0.5 accent-accent" />
                <div>
                  <div>Enable 14-day warmup</div>
                  <div className="text-[11px] text-ink-500 mt-0.5">Ramps from 10/day up to 400/day over 14 days. Essential for brand new {PROVIDER_LABEL[form.provider]} accounts — without it they get flagged as spam fast.</div>
                </div>
              </label>
            </div>

            {err && (
              <div className="mt-4 bg-red-50 text-red-700 text-[13px] px-3 py-2 rounded-md">
                {err}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-ink-100">
              <button type="button" className="btn-quiet" onClick={() => { setAdding(false); setErr(null); }}>Cancel</button>
              <button type="submit" disabled={saving} className="btn-accent">
                {saving ? "Verifying…" : "Add & verify"}
              </button>
            </div>
          </form>
        )}

        {senders === null && <p className="text-[13px] text-ink-500">Loading…</p>}

        {senders?.length === 0 && !adding && (
          <div className="text-center py-16 border border-dashed border-ink-200 rounded-lg">
            <div className="text-[14px] font-medium text-ink mb-1">No senders yet</div>
            <p className="text-[13px] text-ink-500 mb-4">Add a Gmail or Outlook account to start sending.</p>
            <button onClick={() => setAdding(true)} className="btn-accent">Add your first</button>
          </div>
        )}

        {senders && senders.length > 0 && (
          <div className="sheet overflow-hidden">
            {senders.map((s) => (
              <div key={s.id} className="border-b border-ink-100 last:border-b-0">
                {editingId === s.id ? (
                  <div className="px-4 py-4 bg-surface space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="label-cap">Label</label>
                        <input
                          className="field-boxed"
                          value={editForm.label}
                          onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="label-cap">Display name (the recipient sees this)</label>
                        <input
                          className="field-boxed"
                          value={editForm.from_name}
                          onChange={(e) => setEditForm({ ...editForm, from_name: e.target.value })}
                          placeholder="Nishant Raj"
                        />
                      </div>
                    </div>
                    <div className="text-[12px] text-ink-500">
                      Email <span className="font-mono">{s.email}</span> can't be changed. Delete and re-add to switch accounts.
                    </div>
                    <div className="flex justify-end gap-2">
                      <button className="btn-quiet text-[12px]" onClick={() => setEditingId(null)}>Cancel</button>
                      <button className="btn-accent text-[12px]" disabled={editSaving || !editForm.label.trim()} onClick={() => saveEdit(s.id)}>
                        {editSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-hover transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-medium truncate">{s.label}</span>
                        <span className="pill-pause">{PROVIDER_LABEL[s.provider] ?? "Gmail"}</span>
                        {s.is_default && <span className="pill-live">default</span>}
                        {(() => {
                          const w = warmupStatus(s);
                          if (!w) return null;
                          return w.done
                            ? <span className="pill-done">warmup done</span>
                            : <span className="pill-pause">warmup day {w.day}/14 · {w.cap}/day</span>;
                        })()}
                      </div>
                      <div className="text-[13px] text-ink-500 truncate mt-0.5">
                        {s.from_name ? <>{s.from_name} <span className="text-ink-400">&lt;{s.email}&gt;</span></> : s.email}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button className="btn-quiet text-[12px]" onClick={() => startEdit(s)}>Edit</button>
                      {!s.is_default && <button className="btn-quiet text-[12px]" onClick={() => setDefault(s.id)}>Set default</button>}
                      <button className="btn-quiet text-[12px] text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => remove(s.id, s.label)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {ConfirmDialog}
    </AppShell>
  );
}
