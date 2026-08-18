# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Next.js dev server on :3000
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — Next.js / ESLint

No test runner is configured. Don't invent one.

## Architecture

Mailvia is a Next.js 15 (App Router) + Supabase mass-emailing app. It runs on free tiers: Vercel for the app, Supabase for Postgres + Storage + `pg_cron`/`pg_net`, Gmail SMTP for sending.

The most important thing to understand: **the app does not own a scheduler**. Sending and reply polling are driven by `pg_cron` in Supabase, which `pg_net.http_get`s two Next.js API routes on a schedule. The Next.js app is otherwise stateless — every send is one HTTP request.

### The tick loop (`src/app/api/tick/route.ts`)

Hit every minute by `pg_cron`. One tick = at most one email sent. The route:

1. Authenticates the caller via `cronBearerOk` (constant-time compare against `CRON_SECRET`).
2. Loads all `status='running'` campaigns and rotates fairly: the campaign with the oldest most-recent send wins this tick, so one big campaign doesn't starve others.
3. For each candidate, checks gates in order: schedule window (`inWindow` using campaign's `timezone` + per-weekday `schedule`), `start_at`, `gap_seconds` since last send, and daily cap (raw `daily_cap` clamped by `warmupCapForSender` — the 14-day ramp in `src/lib/warmup.ts`).
4. Sends to one pending recipient via `sendMail` (`src/lib/mail.ts`, nodemailer over Gmail SMTP using the per-campaign `sender_id` decrypted by `decryptSecret`, or env fallback).
5. Rewrites the body through `src/lib/template.ts` (merge tags + Markdown → HTML) and injects: tracking pixel (`/api/t/o/...`), rewritten click links (`/api/t/c/...`), and `List-Unsubscribe` header pointing at `/u/[token]`. All three use HMAC tokens signed by `src/lib/tokens.ts`.

Skipped reasons are returned in the response — useful when debugging "campaign stuck at running".

### Reply detection (`src/app/api/check-replies/route.ts` + `src/lib/replies.ts`)

Hit every 5 minutes by `pg_cron`. Polls Gmail IMAP via `imapflow` + `mailparser`, matches incoming messages by `In-Reply-To` / `References` against `recipients.message_id`, captures the body, flips matching recipients to `replied` (which stops follow-ups), and filters out auto-replies and bounces (see recent commits — this logic has been iterated on).

### Data model

`src/lib/supabase.ts` is the single source of truth for shapes. Key tables: `campaigns`, `recipients`, `senders` (encrypted app passwords), `follow_up_steps`, `send_log`, plus tracking/event tables. Schema lives in `supabase/schema.sql`; cron setup in `supabase/cron.sql`.

`cron_config` is a small key/value table read by the cron jobs for `app_url` and `cron_secret` — rotate those by `UPDATE`, not by reinstalling jobs.

`login_attempts` backs per-IP login rate limiting (`src/app/api/auth/login/route.ts`). `unsubscribes` is manageable from the UI at `/unsubscribes` (`src/app/api/unsubscribes/route.ts`), not just via the one-click unsubscribe link.

### Auth

`iron-session` cookie auth, single shared `APP_PASSWORD`. `src/lib/auth.ts` guards UI routes; cron routes use bearer tokens instead.

### Server vs client boundaries

- API routes use `supabaseAdmin()` (service role, bypasses RLS).
- The server-side service role key must never reach the client. RLS is enabled on every table as defense-in-depth.
- Tracking/unsubscribe routes are public but HMAC-verified — never trust path params without going through `tokens.ts`.

### `APP_URL` is load-bearing

Every tracking pixel, click redirect, and unsubscribe link is built from `APP_URL`. If it points at `localhost` in production, every sent email has broken links. When changing deployment URL, update both the Vercel env var **and** `cron_config.app_url`.

## Conventions specific to this repo

- `src/lib/*` files are small and single-purpose (mostly < 100 lines). Prefer extending one of them over creating a new abstraction.
- Path alias `@/` → `src/`.
- Gmail app passwords are stored encrypted (AES-GCM, key derived from `ENCRYPTION_KEY`, falling back to `SESSION_SECRET` if unset); always go through `crypto.ts` — never read `senders.app_password` raw.
- Times are stored UTC; scheduling windows are evaluated in the campaign's `timezone` via `src/lib/time.ts`. Don't `new Date()`-compare hours directly.
