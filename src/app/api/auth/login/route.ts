import { NextRequest, NextResponse } from "next/server";
import { verifyAppPassword, getSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const db = supabaseAdmin();

  const { data: attempt } = await db
    .from("login_attempts")
    .select("fail_count, locked_until")
    .eq("ip", ip)
    .maybeSingle();

  if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
    const retryAfterSec = Math.ceil((new Date(attempt.locked_until).getTime() - Date.now()) / 1000);
    return NextResponse.json(
      { error: "too_many_attempts", retry_after_seconds: retryAfterSec },
      { status: 429 }
    );
  }

  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !(await verifyAppPassword(password))) {
    const nextFailCount = (attempt?.fail_count ?? 0) + 1;
    const lockedUntil = nextFailCount >= MAX_FAILS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
    await db
      .from("login_attempts")
      .upsert(
        { ip, fail_count: lockedUntil ? 0 : nextFailCount, locked_until: lockedUntil, updated_at: new Date().toISOString() },
        { onConflict: "ip" }
      );
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  if (attempt) await db.from("login_attempts").delete().eq("ip", ip);

  const s = await getSession();
  s.loggedIn = true;
  await s.save();
  return NextResponse.json({ ok: true });
}
