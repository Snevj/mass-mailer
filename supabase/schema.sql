-- Run in Supabase SQL Editor. Idempotent — safe to re-run.

create extension if not exists pgcrypto;

create table if not exists senders (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null unique,
  app_password text not null,
  from_name text,
  is_default boolean not null default false,
  warmup_enabled boolean not null default false,
  warmup_started_at timestamptz,
  provider text not null default 'gmail',
  created_at timestamptz not null default now()
);

alter table senders
  add column if not exists warmup_enabled boolean not null default false,
  add column if not exists warmup_started_at timestamptz,
  add column if not exists provider text not null default 'gmail',
  -- Microsoft Graph (app-only OAuth) sender credentials. tenant/client IDs are
  -- not secret; the client secret is stored encrypted in app_password.
  add column if not exists ms_tenant_id text,
  add column if not exists ms_client_id text;

-- Constrain provider to known values (idempotent: drop + recreate).
alter table senders drop constraint if exists senders_provider_check;
alter table senders add constraint senders_provider_check
  check (provider in ('gmail', 'outlook', 'microsoft_graph'));

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  template text not null,
  from_name text,
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'done')),
  daily_cap int not null default 300,
  gap_seconds int not null default 120,
  window_start_hour int not null default 8,
  window_end_hour int not null default 18,
  timezone text not null default 'Asia/Kolkata',
  sender_id uuid references senders(id) on delete set null,
  schedule jsonb,
  follow_ups_enabled boolean not null default false,
  retry_enabled boolean not null default false,
  max_retries int not null default 2,
  attachment_path text,
  attachment_filename text,
  tracking_enabled boolean not null default true,
  unsubscribe_enabled boolean not null default false,
  start_at timestamptz,
  known_vars text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table campaigns
  add column if not exists sender_id uuid references senders(id) on delete set null,
  add column if not exists schedule jsonb,
  add column if not exists follow_ups_enabled boolean not null default false,
  add column if not exists retry_enabled boolean not null default false,
  add column if not exists max_retries int not null default 2,
  add column if not exists attachment_path text,
  add column if not exists attachment_filename text,
  add column if not exists attachment_paths text[] not null default array[]::text[],
  add column if not exists attachment_filenames text[] not null default array[]::text[],
  add column if not exists tracking_enabled boolean not null default false,
  add column if not exists unsubscribe_enabled boolean not null default true,
  add column if not exists start_at timestamptz,
  add column if not exists known_vars text[] not null default array[]::text[],
  add column if not exists archived_at timestamptz;

-- Migrate legacy single-attachment to the new arrays (idempotent).
update campaigns
set attachment_paths = array[attachment_path],
    attachment_filenames = array[coalesce(attachment_filename, 'attachment')]
where attachment_path is not null
  and coalesce(array_length(attachment_paths, 1), 0) = 0;

create index if not exists campaigns_archived_idx on campaigns(archived_at);

create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null,
  company text not null,
  email text not null,
  vars jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped', 'replied', 'unsubscribed', 'bounced')),
  sent_at timestamptz,
  last_sent_at timestamptz,
  follow_up_count int not null default 0,
  next_follow_up_at timestamptz,
  replied_at timestamptz,
  retry_count int not null default 0,
  next_retry_at timestamptz,
  error text,
  row_index int not null default 0,
  created_at timestamptz not null default now(),
  unique (campaign_id, email)
);

alter table recipients
  add column if not exists vars jsonb not null default '{}'::jsonb,
  add column if not exists last_sent_at timestamptz,
  add column if not exists follow_up_count int not null default 0,
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists replied_at timestamptz,
  add column if not exists retry_count int not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists message_id text,
  add column if not exists domain text generated always as (lower(split_part(email, '@', 2))) stored;

-- Older installs may have a stale status check constraint missing the new statuses.
alter table recipients drop constraint if exists recipients_status_check;
alter table recipients add constraint recipients_status_check
  check (status in ('pending', 'sent', 'failed', 'skipped', 'replied', 'unsubscribed', 'bounced'));

create index if not exists recipients_campaign_status_idx on recipients(campaign_id, status);
create index if not exists recipients_row_idx on recipients(campaign_id, row_index);
create index if not exists recipients_next_retry_idx on recipients(next_retry_at) where next_retry_at is not null;
create index if not exists recipients_next_follow_up_idx on recipients(next_follow_up_at) where next_follow_up_at is not null;
create index if not exists recipients_domain_idx on recipients(campaign_id, domain);
create index if not exists campaigns_sender_idx on campaigns(sender_id);
create index if not exists campaigns_status_idx on campaigns(status);

create table if not exists follow_up_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  step_number int not null,
  delay_days numeric not null default 4,
  subject text,
  template text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create table if not exists send_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  recipient_id uuid not null references recipients(id) on delete cascade,
  kind text not null default 'initial' check (kind in ('initial', 'follow_up', 'retry')),
  step_number int,
  sent_at timestamptz not null default now(),
  day date not null default ((now() at time zone 'Asia/Kolkata')::date)
);

alter table send_log
  add column if not exists kind text not null default 'initial',
  add column if not exists step_number int;

create index if not exists send_log_day_idx on send_log(day);
create index if not exists send_log_sent_at_idx on send_log(sent_at desc);
create index if not exists send_log_campaign_kind_idx on send_log(campaign_id, kind);

create table if not exists tracking_events (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references recipients(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  kind text not null check (kind in ('open', 'click')),
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists tracking_events_recipient_idx on tracking_events(recipient_id);
create index if not exists tracking_events_campaign_idx on tracking_events(campaign_id, kind);

create table if not exists unsubscribes (
  email text primary key,
  campaign_id uuid references campaigns(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists replies (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid references recipients(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  from_email text not null,
  subject text,
  snippet text,
  body_text text,
  body_html text,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recipient_id, received_at)
);

alter table replies
  add column if not exists body_text text,
  add column if not exists body_html text;

create index if not exists replies_recipient_idx on replies(recipient_id);
create index if not exists replies_received_at_idx on replies(received_at desc);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists campaigns_set_updated_at on campaigns;
create trigger campaigns_set_updated_at
before update on campaigns
for each row execute function set_updated_at();

-- storage bucket for attachments (idempotent)
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- App-level toggles (read/written by Next.js via service_role).
-- Use this for feature flags, NOT for secrets — secrets live in cron_config
-- which is locked down even from service_role.
create table if not exists app_settings (
  key   text primary key,
  value text not null
);
-- Reply checking is opt-in. See src/app/api/check-replies/route.ts.
insert into app_settings (key, value) values ('reply_check_enabled', 'false')
on conflict (key) do nothing;

-- Login rate limiting — one row per client IP. See src/app/api/auth/login/route.ts.
create table if not exists login_attempts (
  ip           text primary key,
  fail_count   int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- ----- Row-Level Security: default-deny for anon / authenticated roles.
-- The server uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so this
-- doesn't change app behavior. It's defense-in-depth against accidental
-- client-side Supabase use leaking data. Safe to re-run.
alter table senders            enable row level security;
alter table campaigns          enable row level security;
alter table recipients         enable row level security;
alter table follow_up_steps    enable row level security;
alter table send_log           enable row level security;
alter table tracking_events    enable row level security;
alter table unsubscribes       enable row level security;
alter table login_attempts     enable row level security;
alter table replies            enable row level security;
alter table app_settings       enable row level security;
