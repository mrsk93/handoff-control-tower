create type inbox_status as enum ('received', 'processing', 'processed', 'parked', 'dead_letter', 'ignored');
create type outbox_status as enum ('pending', 'dispatching', 'sent', 'retry_wait', 'dead_letter', 'cancelled');

create table inbox_messages (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  source_system text not null,
  message_id text not null,
  event_type text not null,
  event_version integer not null,
  source_entity_id text not null,
  source_version text,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  correlation_id text not null,
  causation_id text,
  idempotency_key text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  status inbox_status not null default 'received',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  prerequisite_type text,
  prerequisite_key text,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null,
  unique (tenant_id, source_system, message_id),
  unique (tenant_id, idempotency_key)
);

create index inbox_claim_idx on inbox_messages (status, available_at);
create index inbox_tenant_idx on inbox_messages (tenant_id);

create table outbox_messages (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  destination text not null,
  message_type text not null,
  message_version integer not null,
  payload jsonb not null,
  idempotency_key text not null,
  correlation_id text not null,
  causation_id text,
  status outbox_status not null default 'pending',
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null,
  unique (tenant_id, destination, idempotency_key)
);

create index outbox_claim_idx on outbox_messages (status, available_at);
create index outbox_tenant_idx on outbox_messages (tenant_id);
