alter table public.days add column if not exists others text[] not null default '{}';
