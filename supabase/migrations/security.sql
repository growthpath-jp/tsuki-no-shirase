-- security hardening: was the start of a period shown to the partner? / one-time transfer codes / faster rate limits
alter table public.periods add column if not exists shared boolean not null default true;
create table if not exists public.transfer_codes (
  code_hash text primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.transfer_codes enable row level security;
create index if not exists rate_hits_key_at_idx on public.rate_hits (key, at);
