-- Gate.io private copy-trading foundation.
-- This migration creates data boundaries and a durable queue; it does not enable live trading.

create extension if not exists pgcrypto;

create type public.member_role as enum ('member', 'admin');
create type public.member_status as enum ('applied', 'pending', 'approved', 'suspended', 'withdrawn');
create type public.exchange_environment as enum ('testnet', 'live');
create type public.exchange_connection_status as enum ('unverified', 'connected', 'error', 'revoked');
create type public.trading_mode as enum ('active', 'reduce_only', 'halted');
create type public.copy_event_status as enum ('detected', 'calculating', 'queued', 'executing', 'reconciling', 'completed', 'partial', 'failed');
create type public.copy_order_status as enum ('pending', 'leased', 'submitted', 'partial_filled', 'filled', 'unknown', 'retrying', 'cancelled', 'failed');
create type public.sync_status as enum ('synced', 'drift', 'error', 'paused');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  status public.member_status not null default 'applied',
  display_name text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  email text,
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0 and used_count <= max_uses),
  expires_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.exchange_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  exchange text not null default 'gateio' check (exchange = 'gateio'),
  environment public.exchange_environment not null default 'testnet',
  uid text not null,
  label text,
  connection_status public.exchange_connection_status not null default 'unverified',
  position_mode text not null default 'single' check (position_mode in ('single', 'dual')),
  api_key_last4 text,
  ip_whitelist_verified boolean not null default false,
  last_verified_at timestamptz,
  last_error_label text,
  last_error_detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, environment, uid)
);

-- No member-facing policy is created for this table. The service-role worker bypasses RLS.
create table public.exchange_api_credentials (
  exchange_account_id uuid primary key references public.exchange_accounts(id) on delete cascade,
  api_key_ciphertext text not null,
  api_secret_ciphertext text not null,
  key_version integer not null default 1 check (key_version > 0),
  encryption_algorithm text not null default 'aes-256-gcm',
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.master_accounts (
  id uuid primary key default gen_random_uuid(),
  exchange_account_id uuid not null unique references public.exchange_accounts(id),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.copy_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  exchange_account_id uuid not null unique references public.exchange_accounts(id) on delete cascade,
  enabled boolean not null default false,
  copy_ratio numeric(10,6) not null default 1 check (copy_ratio >= 0 and copy_ratio <= 2),
  drift_tolerance_ratio numeric(10,8) not null default 0.0005 check (drift_tolerance_ratio >= 0 and drift_tolerance_ratio <= 0.1),
  auto_reconcile boolean not null default true,
  manual_trade_policy text not null default 'block' check (manual_trade_policy in ('block', 'adopt', 'flatten')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.risk_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  max_position_ratio numeric(10,6) not null default 0.30 check (max_position_ratio >= 0 and max_position_ratio <= 10),
  max_daily_loss_ratio numeric(10,6) not null default 0.05 check (max_daily_loss_ratio >= 0 and max_daily_loss_ratio <= 1),
  max_drawdown_ratio numeric(10,6) not null default 0.15 check (max_drawdown_ratio >= 0 and max_drawdown_ratio <= 1),
  max_leverage numeric(10,2) not null default 10 check (max_leverage >= 1 and max_leverage <= 100),
  emergency_stop boolean not null default false,
  emergency_stop_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.system_controls (
  singleton boolean primary key default true check (singleton),
  mode public.trading_mode not null default 'halted',
  copy_enabled boolean not null default false,
  reason text,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);

insert into public.system_controls (singleton, mode, copy_enabled, reason)
values (true, 'halted', false, 'Initial safe default');

create table public.blocked_contracts (
  contract text primary key,
  reason text not null,
  blocked_by uuid not null references public.profiles(id),
  blocked_at timestamptz not null default now(),
  expires_at timestamptz
);

create table public.master_position_snapshots (
  id bigint generated always as identity primary key,
  master_account_id uuid not null references public.master_accounts(id) on delete cascade,
  contract text not null,
  snapshot_version bigint not null,
  exchange_update_id bigint,
  equity numeric(30,12) not null check (equity > 0),
  signed_size numeric(30,12) not null,
  signed_notional numeric(30,12) not null,
  mark_price numeric(30,12) not null,
  entry_price numeric(30,12),
  leverage numeric(20,8),
  source text not null check (source in ('websocket', 'rest_reconcile')),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  unique (master_account_id, contract, snapshot_version)
);

create table public.copy_trade_events (
  id uuid primary key default gen_random_uuid(),
  master_snapshot_id bigint not null references public.master_position_snapshots(id),
  contract text not null,
  event_type text not null check (event_type in ('open', 'add', 'reduce', 'close', 'flip', 'reconcile')),
  status public.copy_event_status not null default 'detected',
  idempotency_key text not null unique,
  detected_at timestamptz not null default now(),
  completed_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create table public.copy_targets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.copy_trade_events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  exchange_account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  contract text not null,
  master_exposure_ratio numeric(20,10) not null,
  requested_position_ratio numeric(20,10) not null,
  target_position_ratio numeric(20,10) not null,
  target_signed_notional numeric(30,12) not null,
  target_signed_size numeric(30,12) not null,
  actual_signed_size numeric(30,12) not null,
  delta_signed_size numeric(30,12) not null,
  sync_status public.sync_status not null default 'drift',
  risk_decision jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  unique (event_id, exchange_account_id, contract)
);

create table public.copy_orders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.copy_trade_events(id) on delete cascade,
  copy_target_id uuid not null references public.copy_targets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  exchange_account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  contract text not null,
  sequence smallint not null check (sequence > 0),
  action text not null check (action in ('open', 'add', 'reduce', 'close', 'flip_close', 'flip_open', 'reconcile')),
  signed_size numeric(30,12) not null,
  reduce_only boolean not null,
  wait_for_previous_fill boolean not null default false,
  gate_order_text text not null,
  exchange_order_id text,
  status public.copy_order_status not null default 'pending',
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries >= 0),
  next_attempt_at timestamptz not null default now(),
  leased_by text,
  leased_at timestamptz,
  submitted_at timestamptz,
  finished_at timestamptz,
  error_label text,
  error_detail text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exchange_account_id, gate_order_text),
  unique (copy_target_id, sequence)
);

create table public.position_snapshots (
  id bigint generated always as identity primary key,
  exchange_account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  contract text not null,
  signed_size numeric(30,12) not null,
  signed_notional numeric(30,12) not null,
  entry_price numeric(30,12),
  mark_price numeric(30,12),
  liquidation_price numeric(30,12),
  unrealized_pnl numeric(30,12),
  leverage numeric(20,8),
  sync_status public.sync_status not null default 'drift',
  observed_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.trade_fills (
  id bigint generated always as identity primary key,
  copy_order_id uuid references public.copy_orders(id) on delete set null,
  exchange_account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  exchange_trade_id text not null,
  exchange_order_id text,
  contract text not null,
  signed_size numeric(30,12) not null,
  price numeric(30,12) not null,
  fee numeric(30,12),
  realized_pnl numeric(30,12),
  liquidity_role text,
  filled_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  unique (exchange_account_id, exchange_trade_id)
);

create table public.daily_account_metrics (
  exchange_account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  metric_date date not null,
  start_equity numeric(30,12) not null,
  end_equity numeric(30,12),
  high_watermark_equity numeric(30,12) not null,
  realized_pnl numeric(30,12) not null default 0,
  fees numeric(30,12) not null default 0,
  funding numeric(30,12) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (exchange_account_id, metric_date)
);

create table public.api_logs (
  id bigint generated always as identity primary key,
  exchange_account_id uuid references public.exchange_accounts(id) on delete set null,
  operation text not null,
  http_status integer,
  exchange_label text,
  retryable boolean,
  latency_ms integer,
  request_id text,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create table public.system_errors (
  id bigint generated always as identity primary key,
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  component text not null,
  code text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index copy_orders_queue_idx
  on public.copy_orders (status, next_attempt_at, created_at)
  where status in ('pending', 'retrying', 'unknown');
create index copy_orders_member_idx on public.copy_orders (user_id, created_at desc);
create index copy_targets_member_contract_idx on public.copy_targets (user_id, contract, calculated_at desc);
create index position_snapshots_account_contract_idx on public.position_snapshots (exchange_account_id, contract, observed_at desc);
create index master_snapshots_contract_idx on public.master_position_snapshots (contract, observed_at desc);
create index fills_member_idx on public.trade_fills (user_id, filled_at desc);
create index system_errors_open_idx on public.system_errors (severity, created_at desc) where resolved_at is null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger exchange_accounts_set_updated_at before update on public.exchange_accounts
for each row execute function public.set_updated_at();
create trigger master_accounts_set_updated_at before update on public.master_accounts
for each row execute function public.set_updated_at();
create trigger copy_settings_set_updated_at before update on public.copy_settings
for each row execute function public.set_updated_at();
create trigger risk_settings_set_updated_at before update on public.risk_settings
for each row execute function public.set_updated_at();
create trigger copy_orders_set_updated_at before update on public.copy_orders
for each row execute function public.set_updated_at();
create trigger daily_account_metrics_set_updated_at before update on public.daily_account_metrics
for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_approved_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  );
$$;

alter table public.profiles enable row level security;
alter table public.invitations enable row level security;
alter table public.exchange_accounts enable row level security;
alter table public.exchange_api_credentials enable row level security;
alter table public.master_accounts enable row level security;
alter table public.copy_settings enable row level security;
alter table public.risk_settings enable row level security;
alter table public.system_controls enable row level security;
alter table public.blocked_contracts enable row level security;
alter table public.master_position_snapshots enable row level security;
alter table public.copy_trade_events enable row level security;
alter table public.copy_targets enable row level security;
alter table public.copy_orders enable row level security;
alter table public.position_snapshots enable row level security;
alter table public.trade_fills enable row level security;
alter table public.daily_account_metrics enable row level security;
alter table public.api_logs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.system_errors enable row level security;

create policy profiles_select_self_or_admin on public.profiles
for select using (id = auth.uid() or public.is_admin());
create policy profiles_update_self_or_admin on public.profiles
for update using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

create policy invitations_admin_all on public.invitations
for all using (public.is_admin()) with check (public.is_admin());

create policy exchange_accounts_select_own_or_admin on public.exchange_accounts
for select using (user_id = auth.uid() or public.is_admin());
create policy exchange_accounts_insert_approved_own_or_admin on public.exchange_accounts
for insert with check ((user_id = auth.uid() and public.is_approved_member()) or public.is_admin());
create policy exchange_accounts_update_own_or_admin on public.exchange_accounts
for update using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

create policy master_accounts_admin_all on public.master_accounts
for all using (public.is_admin()) with check (public.is_admin());

create policy copy_settings_select_own_or_admin on public.copy_settings
for select using (user_id = auth.uid() or public.is_admin());
create policy copy_settings_insert_own_or_admin on public.copy_settings
for insert with check ((user_id = auth.uid() and public.is_approved_member()) or public.is_admin());
create policy copy_settings_update_own_or_admin on public.copy_settings
for update using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

create policy risk_settings_select_own_or_admin on public.risk_settings
for select using (user_id = auth.uid() or public.is_admin());
create policy risk_settings_insert_own_or_admin on public.risk_settings
for insert with check ((user_id = auth.uid() and public.is_approved_member()) or public.is_admin());
create policy risk_settings_update_own_or_admin on public.risk_settings
for update using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

create policy system_controls_admin_all on public.system_controls
for all using (public.is_admin()) with check (public.is_admin());
create policy blocked_contracts_admin_all on public.blocked_contracts
for all using (public.is_admin()) with check (public.is_admin());
create policy master_snapshots_admin_select on public.master_position_snapshots
for select using (public.is_admin());
create policy copy_events_admin_select on public.copy_trade_events
for select using (public.is_admin());

create policy copy_targets_select_own_or_admin on public.copy_targets
for select using (user_id = auth.uid() or public.is_admin());
create policy copy_orders_select_own_or_admin on public.copy_orders
for select using (user_id = auth.uid() or public.is_admin());
create policy position_snapshots_select_own_or_admin on public.position_snapshots
for select using (user_id = auth.uid() or public.is_admin());
create policy trade_fills_select_own_or_admin on public.trade_fills
for select using (user_id = auth.uid() or public.is_admin());
create policy daily_metrics_select_own_or_admin on public.daily_account_metrics
for select using (user_id = auth.uid() or public.is_admin());

create policy api_logs_admin_select on public.api_logs
for select using (public.is_admin());
create policy audit_logs_admin_select on public.audit_logs
for select using (public.is_admin());
create policy system_errors_admin_all on public.system_errors
for all using (public.is_admin()) with check (public.is_admin());

revoke all on public.exchange_api_credentials from anon, authenticated;
revoke all on public.api_logs from anon, authenticated;
revoke insert, update, delete on public.copy_orders from anon, authenticated;
revoke insert, update, delete on public.copy_targets from anon, authenticated;
revoke insert, update, delete on public.position_snapshots from anon, authenticated;
revoke insert, update, delete on public.trade_fills from anon, authenticated;

-- Durable queue leasing. Only the service-role worker may execute this function.
create or replace function public.lease_copy_orders(
  worker_id text,
  batch_size integer default 25,
  lease_timeout interval default interval '30 seconds'
)
returns setof public.copy_orders
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.copy_orders
    where (
      status in ('pending', 'retrying')
      or (status = 'leased' and leased_at < now() - lease_timeout)
    )
      and next_attempt_at <= now()
    order by created_at
    for update skip locked
    limit greatest(1, least(batch_size, 100))
  )
  update public.copy_orders as orders
  set status = 'leased',
      leased_by = worker_id,
      leased_at = now(),
      updated_at = now()
  from candidates
  where orders.id = candidates.id
  returning orders.*;
end;
$$;

revoke all on function public.lease_copy_orders(text, integer, interval) from public, anon, authenticated;
grant execute on function public.lease_copy_orders(text, integer, interval) to service_role;
