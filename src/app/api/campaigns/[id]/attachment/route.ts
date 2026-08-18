import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel serverless functions hard-cap request bodies at 4.5MB regardless of
// app code — anything higher here would fail with a raw platform 413 before
// this handler ever runs, so this stays under that with headroom.
const MAX_BYTES = 4 * 1024 * 1024; // 4MB per file
const MAX_FILES = 5;

async function auth() {
  const s = await getSession();
  return s.loggedIn === true;
}

// POST a new attachment (appends to the array). 413 if already at the cap.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1_000_000).toFixed(1)}MB). Max 4MB per file.` },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("campaigns")
    .select("attachment_paths, attachment_filenames")
    .eq("id", id)
    .maybeSingle();
  const curPaths: string[] = existing?.attachment_paths ?? [];
  const curNames: string[] = existing?.attachment_filenames ?? [];
  if (curPaths.length >= MAX_FILES) {
    return NextResponse.json(
      { error: `At most ${MAX_FILES} attachments per campaign. Remove one first.` },
      { status: 413 }
    );
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await db.storage
    .from("attachments")
    .upload(path, buf, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const nextPaths = [...curPaths, path];
  const nextNames = [...curNames, file.name];

  const { data, error } = await db
    .from("campaigns")
    .update({
      attachment_paths: nextPaths,
      attachment_filenames: nextNames,
      // keep legacy single-attachment columns in sync with the first file
      attachment_path: nextPaths[0] ?? null,
      attachment_filename: nextNames[0] ?? null,
    })
    .eq("id", id)
    .select("attachment_paths, attachment_filenames")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    attachments: (data.attachment_paths ?? []).map((p: string, i: number) => ({
      path: p,
      filename: data.attachment_filenames?.[i] ?? "attachment",
    })),
  });
}

// DELETE — with ?path=... removes one specific attachment. Without, wipes all.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const targetPath = req.nextUrl.searchParams.get("path");
  const db = supabaseAdmin();

  const { data: existing } = await db
    .from("campaigns")
    .select("attachment_paths, attachment_filenames")
    .eq("id", id)
    .maybeSingle();
  const curPaths: string[] = existing?.attachment_paths ?? [];
  const curNames: string[] = existing?.attachment_filenames ?? [];

  let nextPaths: string[];
  let nextNames: string[];
  let toRemove: string[];

  if (targetPath) {
    const idx = curPaths.indexOf(targetPath);
    if (idx === -1) return NextResponse.json({ error: "not_found" }, { status: 404 });
    nextPaths = curPaths.filter((_, i) => i !== idx);
    nextNames = curNames.filter((_, i) => i !== idx);
    toRemove = [targetPath];
  } else {
    nextPaths = [];
    nextNames = [];
    toRemove = curPaths;
  }

  if (toRemove.length > 0) {
    await db.storage.from("attachments").remove(toRemove);
  }

  await db
    .from("campaigns")
    .update({
      attachment_paths: nextPaths,
      attachment_filenames: nextNames,
      attachment_path: nextPaths[0] ?? null,
      attachment_filename: nextNames[0] ?? null,
    })
    .eq("id", id);

  return NextResponse.json({
    attachments: nextPaths.map((p, i) => ({ path: p, filename: nextNames[i] ?? "attachment" })),
  });
}
