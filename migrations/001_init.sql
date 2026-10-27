create table social_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  external_account_id text not null,
  created_at timestamptz not null default now(),
  unique (platform, external_account_id)
);

create table automations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references social_accounts (id),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  current_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index automations_account_idx on automations (account_id) where status = 'active';

create table automation_versions (
  automation_id uuid not null references automations (id),
  version int not null,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  primary key (automation_id, version)
);

create table inbound_events (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  external_event_id text not null,
  kind text not null check (kind in ('comment', 'message')),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (platform, external_event_id)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null,
  automation_version int not null,
  account_id uuid not null references social_accounts (id),
  contact_id text not null,
  trigger_comment_id text not null,
  status text not null check (status in ('queued', 'running', 'waiting', 'completed', 'failed', 'timed_out')),
  outcome text,
  current_step int not null default 0,
  context jsonb not null default '{}',
  input_opened_at timestamptz,
  wait_deadline timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (automation_id, automation_version) references automation_versions (automation_id, version),
  unique (automation_id, trigger_comment_id)
);

-- At most one live conversation per person per account, so a DM reply has exactly one owner.
create unique index one_active_run_per_contact on runs (account_id, contact_id)
  where status in ('running', 'waiting');

create index runs_queued_idx on runs (account_id, contact_id, created_at) where status = 'queued';

create table run_inputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id),
  inbound_event_id uuid not null unique references inbound_events (id),
  text text not null,
  attachments int not null default 0,
  received_at timestamptz not null,
  consumed_at timestamptz
);

create index run_inputs_unconsumed_idx on run_inputs (run_id, received_at) where consumed_at is null;

create table outbound_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id),
  step_index int not null,
  idempotency_key text not null unique,
  kind text not null check (kind in ('comment_reply', 'dm')),
  request jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  attempt_log jsonb not null default '[]',
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outbound_actions_run_idx on outbound_actions (run_id, created_at);
