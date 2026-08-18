# Mailvia

A self-hosted mass-mailing web app — the open-source cousin of Mailmeteor / Lemlist. Send personalized cold-outreach campaigns from your own Gmail account(s), with warmup, follow-ups, open/click tracking, reply detection, and one-click unsubscribe.

Runs entirely on **free tiers**: Vercel (app), Supabase (database + storage + cron), Gmail SMTP (sending).

---

## Features

- **Campaigns** — Upload recipients via Google Sheets or Excel/CSV, write a Markdown body with `{{merge_tags}}`, preview per-recipient, send on a schedule.
- **Autopilot** — Per-day schedule (e.g. Mon-Fri 9-5), daily cap, min gap between sends, timezone-aware.
- **Multiple senders** — Attach different Gmail accounts per campaign; each has its own app password (encrypted at rest).
- **Warmup** — 14-day automatic ramp (10 → 400/day) for new Gmail accounts to build sender reputation.
- **Follow-ups** — Multi-step sequences, threaded as `Re:` replies to the original message. Auto-stops when the recipient replies.
- **Open / click tracking** — Invisible pixel + link rewrites. See per-recipient timeline with device + referrer.
- **Reply detection** — IMAP polling flips recipients to `replied` and captures the full reply body.
- **Unsubscribe** — One-click link with HMAC tokens, added to `List-Unsubscribe` header for Gmail's one-click feature.
- **Attachments** — Up to 5 files per campaign (PDF, DOC, ZIP, etc.).
- **Deliverability hints** — Built-in spam-word detection before send.
- **Command palette** (`⌘K`) — Global search across campaigns, recipients, replies, senders.

## Tech Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind**
- **Supabase** — Postgres, Storage, `pg_cron` + `pg_net` for scheduled ticks
- **nodemailer** (SMTP send) + **imapflow** / **mailparser** (reply polling)
- **iron-session** — cookie auth (single-password login)
- **tiptap** + **tiptap-markdown** — WYSIWYG body editor

---

## Prerequisites

1. **Node.js** ≥ 20 ([download](https://nodejs.org/))
2. **A Supabase project** (free tier — [supabase.com](https://supabase.com/))
3. **A Gmail account** with 2-Step Verification enabled (for the app password)
4. **A Vercel account** (free — [vercel.com](https://vercel.com/)) if you want production deploy
5. **Git**

No Google Cloud API key needed. No paid tier needed for anything.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/<you>/mailvia.git
cd mailvia
npm install
```

### 2. Create a Supabase project

1. Go to [app.supabase.com](https://app.supabase.com/) → **New project**
2. Name it anything (e.g. `mailvia`), pick a region close to you, generate a strong DB password (save it somewhere)
3. Wait ~2 minutes for the project to spin up

### 3. Run the schema

1. In your Supabase project → **SQL Editor** → **New query**
2. Paste the full contents of [`supabase/schema.sql`](supabase/schema.sql)
3. Click **Run**. You should see "Success. No rows returned."
4. This creates all tables, indexes, RLS policies, and the `attachments` storage bucket.

### 4. Create a Gmail app password

App passwords are 16-character alternate passwords that let nodemailer sign in without hitting Google's OAuth flow.

1. Enable **2-Step Verification** on your Google account if not already: [myaccount.google.com/security](https://myaccount.google.com/security)
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. App name: `Mailvia` → **Create**
4. Copy the 16-char password (format like `abcd efgh ijkl mnop` — spaces are OK, app strips them)

### 5. Configure environment variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Then fill in `.env.local`:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → **Project URL** |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → **anon/public key** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role key** (keep secret!) |
| `GMAIL_ADDRESS` | Your Gmail address (fallback sender) |
| `GMAIL_APP_PASSWORD` | The 16-char app password from step 4 |
| `GMAIL_FROM_NAME` | Display name (e.g. `Jane Doe`) |
| `APP_PASSWORD` | Anything you want — this is the login password for the Mailvia UI |
| `SESSION_SECRET` | Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → paste output |
| `ENCRYPTION_KEY` | Same command, a different string. Encrypts stored sender app-passwords — kept separate from `SESSION_SECRET` so rotating one doesn't break the other. Optional (falls back to `SESSION_SECRET`), but set it explicitly for new installs. |
| `CRON_SECRET` | Same command, a different random hex string |
| `APP_URL` | `http://localhost:3000` for local dev. Change to your Vercel URL in production. |

### 6. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), log in with your `APP_PASSWORD`. You should land on an empty campaigns dashboard.

**Quick smoke test:**
1. **Senders** → Add your Gmail address + app password → Save
2. **New campaign** → Fill in a name + subject + body, upload a recipient list (CSV or Google Sheets URL)
3. Send a test email to yourself before hitting Start.

---

## Deploy to Production

### 7. Deploy the app to Vercel

1. Push your repo to GitHub (private or public — your choice)
2. [vercel.com/new](https://vercel.com/new) → import the repo → leave all defaults
3. On the **Environment Variables** screen, paste **every** variable from your `.env.local` — including `APP_URL`, which should be your **production** URL. You won't know this URL yet, so either:
   - Deploy first with a placeholder, then edit `APP_URL` to the real Vercel URL and **redeploy**
   - Or set a custom domain first
4. **Deploy**. Wait ~2 min.

> ⚠️ **Critical**: `APP_URL` in production MUST point to your live Vercel URL (e.g. `https://mailvia-xyz.vercel.app`). If it's `http://localhost:3000`, every email you send will have broken tracking pixels, broken unsubscribe links, and broken click-tracked URLs — recipients will see 404s.

### 8. Set up cron jobs in Supabase

The app needs a minute-by-minute cron to send emails and a 5-min cron to poll for replies. Vercel's free tier only allows daily crons, so we run them **inside Supabase** using `pg_cron` + `pg_net`.

1. Supabase → **Database → Extensions** → enable `pg_cron` and `pg_net` (toggle on if not already)
2. Supabase → **SQL Editor** → paste + **edit the values in** [`supabase/cron.sql`](supabase/cron.sql):
   - Set the `app_url` row to your production URL (e.g. `https://mailvia-xyz.vercel.app`)
   - Set the `cron_secret` row to your `CRON_SECRET` value
3. Run the file

This creates a `public.cron_config` table that stores URL + secret, and two scheduled jobs that read from it. **To change URL or rotate the secret later**, just `update` the table — no need to recreate the jobs.

### 9. Verify cron is working

In Supabase SQL Editor:

```sql
-- Should show 2 active rows
select jobname, schedule, active from cron.job where jobname like 'mail-automation%';

-- Wait 90 seconds, then check HTTP responses — should see status_code = 200
select id, status_code, created
from net._http_response
where created > now() - interval '3 minutes'
order by created desc limit 5;
```

If you see `404 DEPLOYMENT_NOT_FOUND` → `app_url` is wrong. If `401` → `cron_secret` doesn't match `CRON_SECRET` env var on Vercel.

### 10. Enable reply detection (optional)

If you want Mailvia to detect replies automatically:
- Nothing extra needed if Gmail uses the same `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` as the sender. The `check-replies` cron already polls IMAP with those creds.
- Replies will appear on the campaign page and auto-flip matching recipients to `replied` status (stops follow-ups).

---

## First campaign

1. **Senders** (top right) → add at least one Gmail sender (optional — if not, the fallback env Gmail is used)
2. **New campaign**
   - **Recipients**: either paste a Google Sheets URL (sharing: Anyone with link → Viewer) or upload `.csv/.xlsx`. First row = column headers. Must include `Name`, `Company`, `Email` columns. Any other column becomes a `{{merge_tag}}`.
   - **Subject**: e.g. `Hi {{Name}} — quick question about {{Company}}`
   - **Body**: Markdown. Use the toolbar for bold/italic/lists/links. Paste from Gmail/Docs/Word keeps formatting.
   - **Autopilot**: pick days + hours + daily cap + gap
   - **Follow-ups** (optional): add steps with delay in days
   - **Send test** to yourself first
3. Hit **Start campaign** — status flips to `running`, pg_cron takes over

---

## Changing config after deploy

Things like the production URL or cron secret can rotate without touching cron jobs:

```sql
-- Change deployed URL (new Vercel deployment, custom domain, etc.)
update public.cron_config set value = 'https://newurl.vercel.app' where key = 'app_url';

-- Rotate cron secret (also update the CRON_SECRET env var on Vercel + redeploy)
update public.cron_config set value = 'new-random-string' where key = 'cron_secret';
```

---

## Resetting the login password

Mailvia has one shared login password, not per-user accounts — there's no email-based "forgot password" flow. Two ways it's actually stored, checked in this order (`src/lib/auth.ts`):

1. **A custom password**, if one was ever set via **Settings → Change password** in the app. This is hashed (scrypt) and stored in Supabase, table `app_settings`, row `key = 'app_password_hash'`. If this row exists, it **always wins** — changing `APP_PASSWORD` on Vercel does nothing while it's there.
2. **The `APP_PASSWORD` env var**, used only as a fallback when no custom password has been set (or after deleting that row).

**If you're locked out:**

1. In the Supabase dashboard → **Table Editor** → `app_settings`, delete the row where `key = 'app_password_hash'` (if present). This forces the app back to checking `APP_PASSWORD`.
2. In Vercel → your project → **Settings → Environment Variables**, set `APP_PASSWORD` to a new value you'll remember. Note: Vercel treats it as write-only once saved as "Sensitive" — you can't view the old value, only overwrite it.
3. Go to **Deployments** → the latest deployment's `···` menu → **Redeploy**. Env var changes only take effect on a fresh deployment.
4. Log in with the new password. Optionally set a memorable one via **Settings → Change password** afterward — just know that from then on, resetting it again means repeating step 1 first.

---

## Troubleshooting

**Nothing sending — campaign stuck at "running"**
```sql
-- Are the cron jobs active?
select jobname, schedule, active from cron.job where jobname like 'mail-automation%';

-- Recent HTTP responses
select id, status_code, created, content::text
from net._http_response
where created > now() - interval '5 minutes'
order by created desc limit 10;
```
- `status_code = 200` → everything fine, check campaign's schedule + warmup cap
- `401` → secret mismatch (`CRON_SECRET` on Vercel vs `cron_config.cron_secret`)
- `404 DEPLOYMENT_NOT_FOUND` → `app_url` in `cron_config` is wrong
- No rows → `pg_cron` or `pg_net` extension disabled, or cron jobs never installed

**"outside_window" in tick response** — your schedule has today's day disabled or current time is outside the window. Edit the campaign's Autopilot.

**SMTP auth errors** — the Gmail app password was revoked or typed wrong. Regenerate and update the sender.

**Open/click tracking not working in production** — `APP_URL` env var is still `http://localhost:3000`. Set it to production URL and redeploy.

**pgaudit "stack is not empty" in Supabase SQL editor** — open a fresh SQL editor tab; the previous session left pgaudit in a bad state.

---

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── tick/            # Main send loop (hit by pg_cron every minute)
│   │   ├── check-replies/   # IMAP reply polling (every 5 min)
│   │   ├── campaigns/       # CRUD + recipient import + activity
│   │   ├── senders/         # Gmail sender management
│   │   ├── t/o/, t/c/       # Tracking pixel + click redirect
│   │   └── u/[token]        # Unsubscribe
│   ├── campaigns/[id]/      # Campaign detail + edit pages
│   └── senders/             # Sender management UI
├── components/              # React components (CampaignForm, BodyEditor, etc.)
├── lib/
│   ├── supabase.ts          # DB client + types
│   ├── mail.ts              # nodemailer SMTP
│   ├── replies.ts           # IMAP polling
│   ├── warmup.ts            # 14-day ramp logic
│   ├── template.ts          # {{merge_tag}} + Markdown → HTML
│   ├── crypto.ts            # App-password encryption
│   └── tokens.ts            # HMAC signing (unsub / tracking)
└── ...
supabase/
├── schema.sql               # Tables, indexes, RLS, storage bucket
└── cron.sql                 # pg_cron + pg_net setup (run ONCE after deploy)
```

---

## Security notes

- The server uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS. RLS is still enabled on every table as defense-in-depth.
- Gmail app passwords are encrypted with AES-GCM using a key derived from `ENCRYPTION_KEY` (falls back to `SESSION_SECRET` if unset — set it explicitly for new installs so rotating one doesn't break the other). Never commit `.env.local`.
- HMAC-signed tokens (unsubscribe, tracking pixel, click redirect) prevent tampering.
- The cron endpoint uses constant-time secret comparison (`crypto.timingSafeEqual`).
- `APP_PASSWORD` is for the single UI login — pick something strong.
- Login attempts are rate-limited per IP (5 failures locks that IP out for 15 minutes) via the `login_attempts` table. **Existing installs must re-run `supabase/schema.sql`** (it's idempotent — safe to paste and run again) to create this table; without it, login just silently has no rate limiting rather than failing.

---

## License

MIT — do what you want. Just don't send spam.
