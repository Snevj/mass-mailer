import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function auth() {
  const s = await getSession();
  return s.loggedIn === true;
}

export async function GET(req: NextRequest) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const db = supabaseAdmin();
  let query = db
    .from("unsubscribes")
    .select("email, campaign_id, created_at")
    .order("created_at", { ascending: false })
    .range(0, 4999);
  if (q) query = query.ilike("email", `%${q}%`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ unsubscribes: data ?? [] });
}

const AddSchema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = AddSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  const email = parsed.data.email.toLowerCase();
  const db = supabaseAdmin();
  const { error } = await db.from("unsubscribes").upsert({ email }, { onConflict: "email" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Also stop any in-flight sends to this address, same as the one-click flow.
  await db.from("recipients").update({ status: "unsubscribed", next_follow_up_at: null }).eq("email", email);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const email = req.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email_required" }, { status: 400 });
  const db = supabaseAdmin();
  const { error } = await db.from("unsubscribes").delete().eq("email", email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
