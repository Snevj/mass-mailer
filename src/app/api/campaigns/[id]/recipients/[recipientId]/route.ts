import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function auth() {
  const s = await getSession();
  return s.loggedIn === true;
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; recipientId: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, recipientId } = await ctx.params;
  const db = supabaseAdmin();
  const { error } = await db
    .from("recipients")
    .delete()
    .eq("id", recipientId)
    .eq("campaign_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
