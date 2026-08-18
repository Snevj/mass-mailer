"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { render, toHtml, extractTags } from "@/lib/template";
import { DEFAULT_SCHEDULE, type Schedule } from "@/lib/supabase";
import ScheduleEditor from "@/components/ScheduleEditor";
import { spamCheck, spamLevel } from "@/lib/spam";
import BodyEditor, { type BodyEditorHandle } from "@/components/BodyEditor";
import DateTimePicker from "@/components/DateTimePicker";
import { useConfirm } from "@/components/useConfirm";

type Sender = { id: string; label: string; email: string; from_name: string | null; is_default: boolean };
type SampleRow = { name: string; company: string; email: string; vars: Record<string, string> };
type FollowUpStep = { step_number: number; delay_days: number; subject: string | null; template: string };

export type CampaignInitial = {
  id?: string;
  name: string;
  subject: string;
  template: string;
  sender_id: string | null;
  schedule: Schedule | null;
  daily_cap: number;
  gap_seconds: number;
  follow_ups_enabled: boolean;
  retry_enabled: boolean;
  max_retries: number;
  tracking_enabled: boolean;
  unsubscribe_enabled: boolean;
  attachment_path?: string | null;
  attachment_filename: string | null;
  attachment_paths?: string[];
  attachment_filenames?: string[];
  known_vars: string[];
  start_at: string | null;
};

export default function CampaignForm({
  mode,
  initial,
  initialSteps,
}: {
  mode: "new" | "edit";
  initial?: CampaignInitial;
  initialSteps?: FollowUpStep[];
}) {
  const router = useRouter();

  // ---------- senders ----------
  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderId, setSenderId] = useState<string>(initial?.sender_id ?? "");

  // ---------- core fields ----------
  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [template, setTemplate] = useState(initial?.template ?? "Hi {{Name}},\n\n...\n\nThank you,\n");
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  // ---------- recipient source ----------
  const [sourceTab, setSourceTab] = useState<"sheets" | "file">("sheets");
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [availableSheets, setAvailableSheets] = useState<string[] | null>(null);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const [sampleRows, setSampleRows] = useState<SampleRow[]>([]);
  const [sampleTotal, setSampleTotal] = useState(0);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [columns, setColumns] = useState<string[]>(initial?.known_vars ?? []);

  // ---------- autopilot / schedule ----------
  const [schedule, setSchedule] = useState<Schedule>(initial?.schedule ?? DEFAULT_SCHEDULE);
  const [dailyCap, setDailyCap] = useState(initial?.daily_cap ?? 300);
  const [gapSeconds, setGapSeconds] = useState(initial?.gap_seconds ?? 120);
  const [showAutopilot, setShowAutopilot] = useState(false);

  // ---------- feature toggles ----------
  const [followUpsEnabled, setFollowUpsEnabled] = useState(initial?.follow_ups_enabled ?? false);
  const [retryEnabled, setRetryEnabled] = useState(initial?.retry_enabled ?? false);
  const [maxRetries, setMaxRetries] = useState(initial?.max_retries ?? 2);
  const [trackingEnabled, setTrackingEnabled] = useState(initial?.tracking_enabled ?? true);
  const [unsubEnabled, setUnsubEnabled] = useState(initial?.unsubscribe_enabled ?? false);
  const [startAt, setStartAt] = useState<string>(() => {
    if (!initial?.start_at) return "";
    const d = new Date(initial.start_at);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  // ---------- test send ----------
  const [testEmail, setTestEmail] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  // ---------- follow-up steps ----------
  const [steps, setSteps] = useState<FollowUpStep[]>(initialSteps ?? []);

  // ---------- attachment (edit mode can upload inline) ----------
  // Pending (not yet uploaded) files — staged locally until save
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  // Already-uploaded attachments (edit mode, or after initial save)
  const [existingAttachments, setExistingAttachments] = useState<{ path: string; filename: string }[]>(() => {
    if (initial?.attachment_paths && initial.attachment_paths.length > 0) {
      return initial.attachment_paths.map((p, i) => ({ path: p, filename: initial.attachment_filenames?.[i] ?? "attachment" }));
    }
    if (initial?.attachment_path && initial?.attachment_filename) {
      return [{ path: initial.attachment_path, filename: initial.attachment_filename }];
    }
    return [];
  });
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const recipientFileInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_ATTACHMENTS = 5;
  // Vercel serverless functions hard-cap request bodies at 4.5MB regardless of
  // app code, so this must stay below that (with headroom for multipart
  // overhead) or the upload fails with a raw platform 413 before we ever see it.
  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
  const MAX_RECIPIENT_FILE_BYTES = 4 * 1024 * 1024;

  const [saving, setSaving] = useState(false);
  // Set once the campaign row is created in "new" mode. If a later step
  // (recipient import, attachments, follow-ups) fails and the user retries,
  // this lets onSubmit resume against the same row instead of POSTing a
  // second campaign and leaving the first as an orphaned duplicate draft.
  const [createdCampaignId, setCreatedCampaignId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bodyEditorRef = useRef<BodyEditorHandle | null>(null);
  const stepEditorRefs = useRef<Record<number, BodyEditorHandle | null>>({});

  // ---------- effects ----------
  useEffect(() => {
    fetch("/api/senders", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list: Sender[] = d.senders ?? [];
        setSenders(list);
        if (!senderId) {
          const def = list.find((s) => s.is_default) ?? list[0];
          if (def) setSenderId(def.id);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fetch sample rows from google sheets when URL/sheet picked
  useEffect(() => {
    if (sourceTab !== "sheets" || !sheetUrl || !sheetName) {
      if (sourceTab === "sheets") { setSampleRows([]); setSampleTotal(0); }
      return;
    }
    let cancel = false;
    setSampleLoading(true);
    fetch("/api/sheets/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sheetUrl, sheet_name: sheetName, limit: 50 }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return;
        setSampleRows(d.rows ?? []);
        setSampleTotal(d.total ?? 0);
        setColumns(d.columns ?? []);
        setPreviewIdx(0);
      })
      .finally(() => !cancel && setSampleLoading(false));
    return () => { cancel = true; };
  }, [sourceTab, sheetUrl, sheetName]);

  useEffect(() => {
    if (sourceTab !== "file" || !file) {
      if (sourceTab === "file") { setSampleRows([]); setSampleTotal(0); }
      return;
    }
    let cancel = false;
    const fd = new FormData();
    fd.append("file", file);
    setSampleLoading(true);
    fetch("/api/sheets/sample-file", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return;
        setSampleRows(d.rows ?? []);
        setSampleTotal(d.total ?? 0);
        setColumns(d.columns ?? []);
        setPreviewIdx(0);
      })
      .finally(() => !cancel && setSampleLoading(false));
    return () => { cancel = true; };
  }, [sourceTab, file]);

  // ---------- helpers ----------
  async function loadSheets() {
    setErr(null);
    setSheetsLoading(true);
    setAvailableSheets(null);
    setSheetName("");
    try {
      const r = await fetch("/api/sheets/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sheetUrl }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "failed");
      const d = await r.json();
      setAvailableSheets(d.sheets ?? []);
      if (d.sheets?.length) setSheetName(d.sheets[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSheetsLoading(false);
    }
  }

  function insertTagAtCursor(tag: string) {
    if (bodyEditorRef.current) {
      bodyEditorRef.current.insertAtCursor(`{{${tag}}}`);
    } else {
      setTemplate(template + ` {{${tag}}}`);
    }
  }

  function addStep() {
    const n = steps.length + 1;
    setSteps([
      ...steps,
      { step_number: n, delay_days: 4, subject: null, template: `Hi {{Name}},\n\nJust a quick bump on my note from last week — did you get a chance to take a look?\n\nThanks,\n` },
    ]);
  }

  function removeStep(idx: number) {
    const next = steps.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 }));
    setSteps(next);
  }

  function updateStep(idx: number, patch: Partial<FollowUpStep>) {
    setSteps(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  async function uploadOneTo(campaignId: string, f: File): Promise<{ path: string; filename: string }[]> {
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch(`/api/campaigns/${campaignId}/attachment`, { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json()).error ?? "attachment_failed");
    const d = await r.json();
    return d.attachments ?? [];
  }

  function addPending(files: FileList | File[]) {
    const incoming = Array.from(files);
    setErr(null);

    const tooBig = incoming.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const sized = incoming.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    if (tooBig.length > 0) {
      setErr(`${tooBig.map((f) => f.name).join(", ")} — over the 4MB-per-file limit, not added.`);
    }

    const room = MAX_ATTACHMENTS - existingAttachments.length - pendingAttachments.length;
    if (room <= 0) {
      setErr(`At most ${MAX_ATTACHMENTS} attachments per campaign.`);
      return;
    }
    const accepted = sized.slice(0, room);
    if (accepted.length < sized.length) {
      setErr(`Only added ${accepted.length}/${sized.length} — cap is ${MAX_ATTACHMENTS}.`);
    }
    setPendingAttachments([...pendingAttachments, ...accepted]);
  }

  function removePending(idx: number) {
    setPendingAttachments(pendingAttachments.filter((_, i) => i !== idx));
  }

  async function removeExisting(path: string) {
    if (!initial?.id) return;
    const ok = await confirm({ title: "Remove this attachment?", danger: true, confirmLabel: "Remove" });
    if (!ok) return;
    setAttachmentBusy(true);
    try {
      const r = await fetch(`/api/campaigns/${initial.id}/attachment?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (r.ok) {
        const d = await r.json();
        setExistingAttachments(d.attachments ?? []);
      }
    } finally {
      setAttachmentBusy(false);
    }
  }

  // Upload all pending files; used by the "Upload now" button in edit mode.
  async function uploadPendingNow() {
    if (!initial?.id || pendingAttachments.length === 0) return;
    setAttachmentBusy(true);
    setErr(null);
    try {
      let latest: { path: string; filename: string }[] = existingAttachments;
      for (const f of pendingAttachments) {
        latest = await uploadOneTo(initial.id, f);
      }
      setExistingAttachments(latest);
      setPendingAttachments([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function sendTestEmail() {
    setTestMsg(null);
    if (!testEmail) { setTestMsg("Enter an email to send the test to."); return; }
    if (!senderId) { setTestMsg("Pick a sender first."); return; }
    setTestBusy(true);
    const sampleVars = currentSample
      ? { ...currentSample.vars, Name: currentSample.name, Company: currentSample.company }
      : { Name: "Test", Company: "Your Company" };
    try {
      const fd = new FormData();
      fd.append("to", testEmail);
      fd.append("subject", subject);
      fd.append("template", template);
      fd.append("sender_id", senderId);
      fd.append("vars", JSON.stringify(sampleVars));
      if (initial?.id) fd.append("campaign_id", initial.id);
      for (const f of pendingAttachments) fd.append("file", f);

      const r = await fetch("/api/test-send", { method: "POST", body: fd });
      if (!r.ok) {
        setTestMsg((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      } else {
        const d = await r.json().catch(() => ({}));
        const n = d?.attached ?? 0;
        setTestMsg(`Sent to ${testEmail}${n > 0 ? ` with ${n} attachment${n === 1 ? "" : "s"}` : ""} ✓`);
      }
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(false);
    }
  }

  // ---------- submit ----------
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const payload = {
      name, subject, template,
      sender_id: senderId || null,
      schedule,
      daily_cap: dailyCap,
      gap_seconds: gapSeconds,
      follow_ups_enabled: followUpsEnabled,
      retry_enabled: retryEnabled,
      max_retries: maxRetries,
      tracking_enabled: trackingEnabled,
      unsubscribe_enabled: unsubEnabled,
      start_at: startAt ? new Date(startAt).toISOString() : null,
    };

    if (mode === "new") {
      if (sourceTab === "sheets" && (!sheetUrl || !sheetName)) { setErr("Pick a Google Sheet and a tab."); return; }
      if (sourceTab === "file" && !file) { setErr("Upload your Excel file."); return; }
    }

    setSaving(true);
    try {
      let campaignId = initial?.id;
      if (mode === "new") {
        if (createdCampaignId) {
          // A prior attempt already created the row — resume against it
          // instead of creating a second one.
          campaignId = createdCampaignId;
          const res = await fetch(`/api/campaigns/${campaignId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(await errMsg(res));
        } else {
          const res = await fetch("/api/campaigns", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(await errMsg(res));
          const { campaign } = await res.json();
          campaignId = campaign.id;
          setCreatedCampaignId(campaign.id);
        }

        // import recipients
        let upRes: Response;
        if (sourceTab === "sheets") {
          upRes = await fetch(`/api/campaigns/${campaignId}/recipients/sheets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: sheetUrl, sheet_name: sheetName }),
          });
        } else {
          const fd = new FormData();
          fd.append("file", file!);
          upRes = await fetch(`/api/campaigns/${campaignId}/recipients`, { method: "POST", body: fd });
        }
        if (!upRes.ok) throw new Error(await errMsg(upRes));

        for (const f of pendingAttachments) {
          await uploadOneTo(campaignId!, f);
        }
      } else {
        const res = await fetch(`/api/campaigns/${campaignId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await errMsg(res));

        // Upload any still-pending attachments
        for (const f of pendingAttachments) {
          await uploadOneTo(campaignId!, f);
        }

        // in edit mode, also import recipients if the user picked a fresh source
        if (sourceTab === "sheets" && sheetUrl && sheetName) {
          const upRes = await fetch(`/api/campaigns/${campaignId}/recipients/sheets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: sheetUrl, sheet_name: sheetName }),
          });
          if (!upRes.ok) throw new Error(await errMsg(upRes));
        } else if (sourceTab === "file" && file) {
          const fd = new FormData();
          fd.append("file", file);
          const upRes = await fetch(`/api/campaigns/${campaignId}/recipients`, { method: "POST", body: fd });
          if (!upRes.ok) throw new Error(await errMsg(upRes));
        }
      }

      // replace follow-up steps (ok to send empty array)
      const fuRes = await fetch(`/api/campaigns/${campaignId}/follow-ups`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps }),
      });
      if (!fuRes.ok) throw new Error(await errMsg(fuRes));

      router.push(`/campaigns/${campaignId}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // ---------- derived ----------
  const selectedSender = useMemo(() => senders.find((s) => s.id === senderId), [senders, senderId]);
  const currentSample = sampleRows[previewIdx];
  const previewVars: Record<string, string> = currentSample
    ? { ...currentSample.vars, Name: currentSample.name, Company: currentSample.company }
    : { Name: "John", Company: "Acme Inc" };
  const previewHtml = useMemo(
    () => toHtml(render(template, previewVars, { escapeForHtml: true })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [template, JSON.stringify(previewVars)]
  );

  const allKnownVars = useMemo(() => {
    const s = new Set<string>([...columns, ...(initial?.known_vars ?? [])]);
    return Array.from(s);
  }, [columns, initial?.known_vars]);

  const usedTags = useMemo(() => extractTags(template), [template]);
  const missingTags = usedTags.filter((t) => !["Name", "Company"].includes(t) && !allKnownVars.includes(t));

  const spam = useMemo(() => spamCheck(subject, template), [subject, template]);
  const sLevel = spamLevel(spam.score);

  const enabledDayCount = Object.values(schedule).filter((d) => d.enabled).length;

  const activePreset = (() => {
    const keys: Array<keyof Schedule> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const weekend = (k: keyof Schedule) => k === "sat" || k === "sun";
    if (keys.every((k) => schedule[k].enabled && schedule[k].start === "00:00" && schedule[k].end === "23:59")) return "Send anytime";
    if (keys.every((k) => schedule[k].enabled === !weekend(k) && schedule[k].start === "09:00" && schedule[k].end === "17:00")) return "Business hours";
    if (keys.every((k) => schedule[k].enabled === !weekend(k) && schedule[k].start === "08:00" && schedule[k].end === "18:00")) return "Weekdays 8–6";
    if (enabledDayCount === 0) return "Disabled";
    return "Custom";
  })();

  return (
    <div className="page">
      <div className="flex items-start justify-between gap-4 pb-5 mb-6 border-b border-ink-200">
        <div>
          <Link href={mode === "edit" ? `/campaigns/${initial?.id}` : "/"} className="btn-link text-[12px] mb-1 inline-flex">
            ← {mode === "edit" ? "Back to campaign" : "Back to campaigns"}
          </Link>
          <h1 className="text-[24px] font-bold tracking-tight">{mode === "new" ? "New campaign" : "Edit campaign"}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => router.back()} className="btn-quiet">Cancel</button>
          <button type="submit" form="campaign-form" disabled={saving} className="btn-accent">
            {saving ? "Saving…" : mode === "new" ? "Create campaign" : "Save changes"}
          </button>
        </div>
      </div>

      <form id="campaign-form" onSubmit={onSubmit} className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-10">
        <div className="space-y-10">
          {/* --- basics --- */}
          <section className="sheet p-6 space-y-5">
            <div>
              <label className="label-cap">Campaign name</label>
              <input className="field-boxed" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tier 1 companies — batch 1" required />
            </div>
            <div>
              <label className="label-cap">From</label>
              {senders.length > 0 ? (
                <select className="field-boxed" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
                  {senders.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.from_name ? `${s.from_name} <${s.email}>` : s.email}{s.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-[13px] text-ink-500 py-2">
                  No senders yet. <Link className="btn-link" href="/senders">Add one →</Link>
                </div>
              )}
            </div>
            <div>
              <label className="label-cap">Recipients</label>
              <div className="tab-group mb-3">
                <button type="button" onClick={() => setSourceTab("sheets")} className={`tab ${sourceTab === "sheets" ? "tab-active" : ""}`}>Google Sheets</button>
                <button type="button" onClick={() => setSourceTab("file")} className={`tab ${sourceTab === "file" ? "tab-active" : ""}`}>Upload file</button>
              </div>
              {sourceTab === "sheets" ? (
                <div className="space-y-2.5">
                  <div className="flex gap-2">
                    <input
                      className="field-boxed flex-1"
                      placeholder="https://docs.google.com/spreadsheets/d/…"
                      value={sheetUrl}
                      onChange={(e) => { setSheetUrl(e.target.value); setAvailableSheets(null); setSheetName(""); }}
                    />
                    <button type="button" className="btn-ghost" disabled={!sheetUrl || sheetsLoading} onClick={loadSheets}>
                      {sheetsLoading ? "Loading…" : "Load"}
                    </button>
                  </div>
                  {availableSheets && (
                    <div>
                      <label className="label-cap">Pick sheet ({availableSheets.length} found)</label>
                      <select className="field-boxed" value={sheetName} onChange={(e) => setSheetName(e.target.value)}>
                        {availableSheets.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  )}
                  <p className="text-[12px] text-ink-500">Sheet must be shared as "Anyone with the link can view". Any column becomes a merge tag.</p>
                </div>
              ) : (
                <>
                  <input
                    ref={recipientFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (f && f.size > MAX_RECIPIENT_FILE_BYTES) {
                        setErr(`${f.name} is ${(f.size / 1_000_000).toFixed(1)}MB — max 4MB for recipient files.`);
                        e.target.value = "";
                        return;
                      }
                      setErr(null);
                      setFile(f);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => recipientFileInputRef.current?.click()}
                    className={`w-full file-dropzone ${file ? "file-dropzone--filled" : ""}`}
                  >
                    <svg className="w-5 h-5 text-ink-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                    </svg>
                    <div className="text-left">
                      {file ? (
                        <>
                          <div className="text-ink font-medium">{file.name}</div>
                          <div className="text-[11px] text-ink-500">{(file.size / 1024).toFixed(1)} KB · click to replace</div>
                        </>
                      ) : (
                        <>
                          <div className="text-ink font-medium">Click to upload</div>
                          <div className="text-[11px] text-ink-500">.xlsx, .xls or .csv — any column becomes a merge tag</div>
                        </>
                      )}
                    </div>
                  </button>
                </>
              )}
            </div>
            <div>
              <label className="label-cap">Subject line</label>
              <input className="field-boxed" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="SDE-1 | IIT Kharagpur 2026 | …" required />
            </div>
          </section>

          {/* --- body --- */}
          <section className="sheet p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Body</h2>
              <div className="tab-group">
                <button type="button" onClick={() => setTab("edit")} className={`tab ${tab === "edit" ? "tab-active" : ""}`}>Edit</button>
                <button type="button" onClick={() => setTab("preview")} className={`tab ${tab === "preview" ? "tab-active" : ""}`}>Preview</button>
              </div>
            </div>

            {allKnownVars.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-ink-500 uppercase tracking-wider mr-1">Insert</span>
                {allKnownVars.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertTagAtCursor(v)}
                    className="text-[11px] px-2 py-1 rounded border border-ink-200 bg-surface text-ink-700 hover:border-ink-400 hover:bg-hover transition-colors font-mono"
                  >
                    {"{{"}{v}{"}}"}
                  </button>
                ))}
              </div>
            )}

            {tab === "edit" ? (
              <BodyEditor
                ref={bodyEditorRef}
                value={template}
                onChange={setTemplate}
                placeholder="Hi {{Name}}, …"
                minHeight={420}
              />
            ) : (
              <div className="border border-ink-200 bg-paper rounded-md overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-ink-200 bg-surface">
                  <div className="min-w-0 flex-1">
                    {sampleLoading ? (
                      <span className="text-[12px] text-ink-500">Loading recipients…</span>
                    ) : currentSample ? (
                      <>
                        <div className="text-[13px] font-medium text-ink truncate">
                          {currentSample.name}
                          <span className="text-ink-400 font-normal"> · </span>
                          {currentSample.company}
                        </div>
                        <div className="text-[11px] font-mono text-ink-500 truncate">{currentSample.email}</div>
                      </>
                    ) : (
                      <div className="text-[12px] text-ink-500">
                        <span className="text-[11px] font-medium uppercase tracking-wider mr-2">Sample</span>
                        <b className="text-ink font-medium">John</b> · <b className="text-ink font-medium">Acme Inc</b>
                      </div>
                    )}
                  </div>
                  {sampleRows.length > 0 && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setPreviewIdx(Math.max(0, previewIdx - 1))}
                        disabled={previewIdx === 0}
                        className="w-7 h-7 flex items-center justify-center rounded text-ink-600 hover:bg-hover hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Previous recipient"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                      </button>
                      <span className="text-[11px] text-ink-500 px-2 font-mono tabular-nums whitespace-nowrap">
                        {previewIdx + 1} / {sampleRows.length}
                        {sampleTotal > sampleRows.length && <span className="text-ink-400"> · {sampleTotal}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPreviewIdx(Math.min(sampleRows.length - 1, previewIdx + 1))}
                        disabled={previewIdx >= sampleRows.length - 1}
                        className="w-7 h-7 flex items-center justify-center rounded text-ink-600 hover:bg-hover hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Next recipient"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                      </button>
                    </div>
                  )}
                </div>
                <div className="email-preview p-5 min-h-[380px] max-h-[600px] overflow-auto bg-paper text-ink">
                  <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  {(() => {
                    const all = [
                      ...existingAttachments.map((a) => ({ name: a.filename, size: null as number | null })),
                      ...pendingAttachments.map((f) => ({ name: f.name, size: f.size })),
                    ];
                    if (all.length === 0) return null;
                    return (
                      <div className="mt-6 pt-4 border-t border-ink-200">
                        <div className="text-[11px] font-medium text-ink-500 uppercase tracking-wider mb-2">
                          {all.length} attachment{all.length !== 1 ? "s" : ""}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {all.map((a, i) => (
                            <div key={i} className="inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 border border-ink-200 rounded-md bg-surface max-w-full">
                              <svg className="w-4 h-4 text-ink-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 0117.98 8.6l-8.07 8.07a2 2 0 11-2.83-2.83l7.77-7.77" />
                              </svg>
                              <div className="min-w-0">
                                <div className="text-[12px] font-medium truncate max-w-[220px]" title={a.name}>{a.name}</div>
                                {a.size !== null && (
                                  <div className="text-[10px] text-ink-500">
                                    {a.size < 1024 * 1024 ? `${(a.size / 1024).toFixed(1)} KB` : `${(a.size / 1024 / 1024).toFixed(1)} MB`}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
            {missingTags.length > 0 && (
              <div className="pill-warn normal-case tracking-normal text-xs">
                Unknown tags: {missingTags.map((t) => `{{${t}}}`).join(", ")} — they'll appear as-is in the sent email.
              </div>
            )}
            <p className="kicker text-ink-400 normal-case tracking-normal">
              <code className="font-mono">{"{{ColumnName}}"}</code> for any column. Markdown links <code className="font-mono">[text](url)</code> become real hyperlinks.
            </p>
          </section>

          {/* --- follow-ups --- */}
          <section className={`sheet ${followUpsEnabled ? "p-6" : "p-4"}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-accent"
                checked={followUpsEnabled}
                onChange={(e) => setFollowUpsEnabled(e.target.checked)}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[15px] font-semibold">Follow-ups</span>
                  {followUpsEnabled ? (
                    <span className="pill-live">on</span>
                  ) : (
                    <span className="pill-draft">off</span>
                  )}
                  <span className="text-[12px] text-ink-500">
                    +30–50% reply rate · auto-stops on reply
                  </span>
                </div>
              </div>
            </label>

            {followUpsEnabled && (
              <div className="rule pt-6 space-y-5">
                {steps.length === 0 && (
                  <p className="text-sm text-ink-500">No follow-ups yet. Add at least one.</p>
                )}
                {steps.map((s, i) => (
                  <div key={i} className="border border-ink-200 p-5 relative">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-baseline gap-3">
                        <span className="font-display text-2xl font-medium">№{String(s.step_number).padStart(2, "0")}</span>
                        <span className="kicker">Follow-up {s.step_number}</span>
                      </div>
                      <button type="button" className="btn-quiet text-xs text-red-700 hover:bg-red-50" onClick={() => removeStep(i)}>Remove</button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-[120px,1fr] gap-x-6 gap-y-4">
                      <div>
                        <label className="label-cap">Delay</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min={0.5} step={0.5} className="field w-20" value={s.delay_days} onChange={(e) => updateStep(i, { delay_days: Number(e.target.value) || 1 })} />
                          <span className="text-sm text-ink-500">days</span>
                        </div>
                      </div>
                      <div>
                        <label className="label-cap">Subject override (optional)</label>
                        <input className="field" placeholder="leave blank to reuse original" value={s.subject ?? ""} onChange={(e) => updateStep(i, { subject: e.target.value || null })} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label-cap">Body</label>
                        <BodyEditor
                          ref={(inst) => { stepEditorRefs.current[i] = inst; }}
                          value={s.template}
                          onChange={(v) => updateStep(i, { template: v })}
                          placeholder="Hi {{Name}}, just bumping this up…"
                          minHeight={160}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={addStep} className="btn-ghost text-xs">+ Add follow-up step</button>
              </div>
            )}
          </section>
        </div>

        {/* --- sidebar --- */}
        <aside className="space-y-6">
          <div className="sheet p-5">
            <h3 className="text-[14px] font-semibold mb-1">Send a test</h3>
            <p className="text-[12px] text-ink-500 mb-3">Fire one preview email to your inbox.</p>
            <input
              type="email"
              className="field-boxed text-[13px]"
              placeholder="you@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
            />
            <button type="button" onClick={sendTestEmail} disabled={testBusy} className="btn-ghost w-full mt-2 text-[13px]">
              {testBusy ? "Sending…" : "Send test"}
            </button>
            {testMsg && (
              <p className={`text-[12px] mt-2 ${testMsg.includes("✓") ? "text-emerald-600" : "text-red-600"}`}>{testMsg}</p>
            )}
          </div>

          <div className="sheet p-5">
            <h3 className="text-[14px] font-semibold mb-1">Schedule start</h3>
            <p className="text-[12px] text-ink-500 mb-3">Optional. Blank = start when you click Send.</p>
            <DateTimePicker value={startAt} onChange={setStartAt} placeholder="Pick date & time" />
          </div>

          <div className="sheet p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[14px] font-semibold">Autopilot</h3>
              <button type="button" onClick={() => setShowAutopilot(true)} className="btn-quiet text-[12px]">Edit</button>
            </div>
            <dl className="space-y-1.5 text-[13px]">
              <div className="flex justify-between items-center">
                <dt className="text-ink-500">Preset</dt>
                <dd>
                  <span className={`pill ${activePreset === "Custom" || activePreset === "Disabled" ? "pill-draft" : "pill-ink"}`}>
                    {activePreset === "Send anytime" && (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                    )}
                    {activePreset}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between"><dt className="text-ink-500">Active days</dt><dd className="font-medium">{enabledDayCount} / 7</dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">Gap</dt><dd className="font-medium">{(gapSeconds / 60).toFixed(1)} min</dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">Max/day</dt><dd className="font-medium">{dailyCap}</dd></div>
            </dl>
          </div>

          <div className="sheet p-5 space-y-3.5">
            <h3 className="text-[14px] font-semibold">Delivery</h3>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-accent shrink-0" checked={retryEnabled} onChange={(e) => setRetryEnabled(e.target.checked)} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">Retry failed sends</div>
                <div className="text-[12px] text-ink-500">Auto-retry after 30 min on SMTP errors.</div>
                {retryEnabled && (
                  <div className="mt-2 flex items-center gap-2 text-[12px]">
                    <span className="text-ink-600">Max</span>
                    <input type="number" min={1} max={5} className="field-boxed !py-1 !px-2 w-14 text-[12px]" value={maxRetries} onChange={(e) => setMaxRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />
                    <span className="text-ink-500">attempts</span>
                  </div>
                )}
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-accent shrink-0" checked={trackingEnabled} onChange={(e) => setTrackingEnabled(e.target.checked)} />
              <div>
                <div className="text-[13px] font-medium">Track opens &amp; clicks</div>
                <div className="text-[12px] text-ink-500">Invisible pixel + link rewrites.</div>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-accent shrink-0" checked={unsubEnabled} onChange={(e) => setUnsubEnabled(e.target.checked)} />
              <div>
                <div className="text-[13px] font-medium">Unsubscribe link</div>
                <div className="text-[12px] text-ink-500">Recommended — protects sender rep.</div>
              </div>
            </label>
          </div>

          {/* attachments (up to 5) */}
          <div className="sheet p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[14px] font-semibold">Attachments</h3>
              <span className="text-[11px] text-ink-500 font-mono">
                {existingAttachments.length + pendingAttachments.length}/{MAX_ATTACHMENTS}
              </span>
            </div>

            <input
              ref={attachInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.zip,.txt,.rtf,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) addPending(e.target.files);
                e.target.value = "";
              }}
            />

            {(existingAttachments.length > 0 || pendingAttachments.length > 0) && (
              <div className="space-y-1.5 mb-3">
                {existingAttachments.map((a) => (
                  <div key={a.path} className="flex items-center justify-between gap-2 px-3 py-2 border border-ink-200 rounded-md bg-surface">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-ink-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                      <span className="text-[13px] truncate" title={a.filename}>{a.filename}</span>
                    </div>
                    {mode === "edit" && (
                      <button
                        type="button"
                        onClick={() => removeExisting(a.path)}
                        disabled={attachmentBusy}
                        className="btn-quiet !px-2 !py-1 text-[12px] text-red-600 hover:bg-red-50 hover:text-red-700 shrink-0"
                        aria-label="Remove attachment"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M6 18L18 6" /></svg>
                      </button>
                    )}
                  </div>
                ))}
                {pendingAttachments.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 px-3 py-2 border border-dashed border-ink-300 rounded-md bg-surface">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-ink-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M5 11l7-7 7 7M5 20h14" /></svg>
                      <div className="min-w-0">
                        <div className="text-[13px] truncate">{f.name}</div>
                        <div className="text-[10px] text-ink-500">
                          {f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`}
                          <span className="ml-1">· pending upload</span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removePending(i)}
                      className="btn-quiet !px-2 !py-1 text-[12px] text-ink-500 hover:text-ink shrink-0"
                      aria-label="Remove pending file"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M6 18L18 6" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {existingAttachments.length + pendingAttachments.length < MAX_ATTACHMENTS && (
              <button
                type="button"
                onClick={() => attachInputRef.current?.click()}
                className="w-full file-dropzone"
              >
                <svg className="w-4 h-4 text-ink-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.48-8.48l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 11-2.83-2.83l8.49-8.49" />
                </svg>
                <div className="text-[12px] text-left">
                  <div className="text-ink font-medium">
                    {existingAttachments.length + pendingAttachments.length === 0 ? "Attach files" : "Add another file"}
                  </div>
                  <div className="text-[11px] text-ink-500">PDF, DOC, DOCX, ZIP · max 4MB each · up to {MAX_ATTACHMENTS} files</div>
                </div>
              </button>
            )}

            {mode === "edit" && pendingAttachments.length > 0 && (
              <button
                type="button"
                onClick={uploadPendingNow}
                disabled={attachmentBusy}
                className="btn-ghost text-[12px] w-full mt-2"
              >
                {attachmentBusy ? "Uploading…" : `Upload ${pendingAttachments.length} pending ${pendingAttachments.length === 1 ? "file" : "files"}`}
              </button>
            )}
          </div>

          {selectedSender && (
            <div className="sheet p-5">
              <h3 className="text-[14px] font-semibold mb-1">Sending from</h3>
              <div className="text-[13px]">{selectedSender.from_name ?? selectedSender.label}</div>
              <div className="text-[12px] text-ink-500 font-mono truncate">{selectedSender.email}</div>
            </div>
          )}

          <div className="sheet p-6">
            <div className="flex items-baseline justify-between">
              <div className="kicker">Deliverability</div>
              <span className={`text-xs font-mono ${sLevel === "clean" ? "text-emerald-700" : sLevel === "caution" ? "text-amber-700" : "text-red-700"}`}>
                {sLevel}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1 h-[3px] bg-ink-100 relative">
                <div
                  className={`h-full transition-all ${sLevel === "clean" ? "bg-emerald-500" : sLevel === "caution" ? "bg-amber-500" : "bg-red-500"}`}
                  style={{ width: `${Math.min(100, Math.max(6, spam.score))}%` }}
                />
              </div>
              <div className="text-xs font-mono text-ink-500 w-10 text-right">{spam.score}/100</div>
            </div>
            {spam.warnings.length > 0 && (
              <ul className="mt-3 text-xs text-ink-600 space-y-1 list-disc pl-4">
                {spam.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
                {spam.warnings.length > 5 && <li className="text-ink-400">+{spam.warnings.length - 5} more</li>}
              </ul>
            )}
            {sLevel === "clean" && spam.warnings.length === 0 && (
              <p className="mt-3 text-xs text-ink-500">No red flags detected.</p>
            )}
          </div>

          {err && (
            <div className="pill-warn normal-case tracking-normal text-xs whitespace-normal p-3 block">
              {err}
            </div>
          )}
        </aside>
      </form>

      {showAutopilot && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center p-4 z-50" onClick={() => setShowAutopilot(false)}>
          <div className="sheet max-w-3xl w-full max-h-[90vh] overflow-auto p-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="kicker">Autopilot</div>
                <h2 className="display-md mt-1">Cadence &amp; rate</h2>
              </div>
              <button type="button" onClick={() => setShowAutopilot(false)} className="btn-quiet p-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M6 18L18 6" strokeLinecap="round"/></svg>
              </button>
            </div>
            <ScheduleEditor
              schedule={schedule}
              onChange={setSchedule}
              dailyCap={dailyCap}
              onDailyCap={setDailyCap}
              gapSeconds={gapSeconds}
              onGapSeconds={setGapSeconds}
              totalRecipients={sampleTotal || sampleRows.length || undefined}
            />
            <div className="flex justify-end mt-8 rule pt-6">
              <button type="button" className="btn-accent" onClick={() => setShowAutopilot(false)}>Apply</button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}

async function errMsg(r: Response) {
  try {
    const j = await r.json();
    if (typeof j.error === "string") return j.error;
    if (j.error) return JSON.stringify(j.error);
  } catch {}
  return `HTTP ${r.status}`;
}
