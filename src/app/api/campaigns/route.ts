import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DayScheduleSchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
const ScheduleSchema = z.object({
  mon: DayScheduleSchema, tue: DayScheduleSchema, wed: DayScheduleSchema,
  thu: DayScheduleSchema, fri: DayScheduleSchema, sat: DayScheduleSchema, sun: DayScheduleSchema,
}).nullable().optional();

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  template: z.string().min(1),
  from_name: z.string().max(200).optional().nullable(),
  sender_id: z.string().uuid().nullable().optional(),
  schedule: ScheduleSchema,
  daily_cap: z.number().int().min(1).max(2000).optional(),
  gap_seconds: z.number().int().min(30).max(3600).optional(),
  window_start_hour: z.number().int().min(0).max(23).optional(),
  window_end_hour: z.number().int().min(1).max(24).optional(),
  timezone: z.string().optional(),
  follow_ups_enabled: z.boolean().optional(),
  retry_enabled: z.boolean().optional(),
  max_retries: z.number().int().min(1).max(5).optional(),
  tracking_enabled: z.boolean().optional(),
  unsubscribe_enabled: z.boolean().optional(),
  start_at: z.string().datetime().nullable().optional(),
});

export async function GET(req: Request) {
  const s = await getSession();
  if (!s.loggedIn) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  const db = supabaseAdmin();
  let q = db.from("campaigns").select("*").order("created_at", { ascending: false });
  if (!includeArchived) q = q.is("archived_at", null);
  const { data: campaigns, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // One query for every recipient's (campaign_id, status), aggregated here —
  // instead of 3 count queries per campaign (3N round-trips to Supabase for
  // N campaigns), this is a single round-trip regardless of campaign count.
  const campaignIds = (campaigns ?? []).map((c) => c.id);
  const counts = new Map<string, { total: number; sent: number; failed: number }>();
  if (campaignIds.length > 0) {
    const { data: statusRows } = await db
      .from("recipients")
      .select("campaign_id, status")
      .in("campaign_id", campaignIds)
      .range(0, 99999);
    for (const r of statusRows ?? []) {
      const c = counts.get(r.campaign_id) ?? { total: 0, sent: 0, failed: 0 };
      c.total++;
      if (r.status === "sent" || r.status === "replied") c.sent++;
      if (r.status === "failed" || r.status === "bounced") c.failed++;
      counts.set(r.campaign_id, c);
    }
  }
  const enriched = (campaigns ?? []).map((c) => {
    const cc = counts.get(c.id) ?? { total: 0, sent: 0, failed: 0 };
    return { ...c, total: cc.total, sent: cc.sent, failed: cc.failed };
  });
  return NextResponse.json({ campaigns: enriched });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s.loggedIn) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("campaigns").insert(parsed.data).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
