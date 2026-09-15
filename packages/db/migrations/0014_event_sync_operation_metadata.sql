-- The existing inbox is the integration-event ledger. Extend it in place so a
-- delivery cannot be recorded twice in a competing integration_events table.
alter table inbox_messages add column connection_id uuid;
alter table inbox_messages add column observed_at timestamptz;
update inbox_messages set observed_at = received_at where observed_at is null;
alter table inbox_messages alter column observed_at set not null;
alter table inbox_messages add column source_api_version text;
alter table inbox_messages add column signature_verified boolean not null default false;
alter table inbox_messages add column signature_verified_at timestamptz;
alter table inbox_messages add column last_applied_event_id text;
alter table inbox_messages add column error_code text;
alter table inbox_messages
  add constraint inbox_messages_tenant_connection_fk
  foreign key (tenant_id, connection_id) references connections (tenant_id, id);
create index inbox_connection_observed_idx on inbox_messages (tenant_id, connection_id, observed_at);

alter table outbox_messages add column connection_id uuid;
alter table outbox_messages add column sync_operation_id uuid;
alter table outbox_messages add column workflow_type text;
alter table outbox_messages add column aggregate_type text;
alter table outbox_messages add column aggregate_id text;
alter table outbox_messages add column provider_api_version text;
alter table outbox_messages add column last_request_id text;
alter table outbox_messages
  add constraint outbox_messages_tenant_connection_fk
  foreign key (tenant_id, connection_id) references connections (tenant_id, id);
create index outbox_connection_idx on outbox_messages (tenant_id, connection_id, created_at);

create type sync_operation_status as enum (
  'pending', 'running', 'succeeded', 'retrying', 'failed', 'dead_letter', 'cancelled'
);

create table sync_operations (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  connection_id uuid,
  workflow_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  direction text not null,
  idempotency_key text not null,
  status sync_operation_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint sync_operations_tenant_idempotency_uq unique (tenant_id, idempotency_key),
  constraint sync_operations_tenant_id_uq unique (tenant_id, id),
  constraint sync_operations_tenant_connection_fk
    foreign key (tenant_id, connection_id) references connections (tenant_id, id),
  constraint sync_operations_text_fields_ck check (
    length(trim(workflow_type)) > 0 and
    length(trim(aggregate_type)) > 0 and
    length(trim(aggregate_id)) > 0 and
    length(trim(direction)) > 0 and
    length(trim(idempotency_key)) > 0
  )
);

create index sync_operations_claim_idx on sync_operations (status, next_attempt_at);
create index sync_operations_aggregate_idx
  on sync_operations (tenant_id, aggregate_type, aggregate_id, created_at);
create index sync_operations_tenant_idx on sync_operations (tenant_id);

alter table outbox_messages
  add constraint outbox_messages_tenant_operation_fk
  foreign key (tenant_id, sync_operation_id) references sync_operations (tenant_id, id);
create index outbox_sync_operation_idx on outbox_messages (tenant_id, sync_operation_id);

create table sync_attempts (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  operation_id uuid not null,
  attempt integer not null check (attempt >= 1),
  outcome text not null check (length(trim(outcome)) > 0),
  http_method text,
  request_path text,
  status_code integer check (status_code is null or (status_code >= 100 and status_code <= 599)),
  request_id text,
  retry_after_ms integer check (retry_after_ms is null or retry_after_ms >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  error_code text,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  constraint sync_attempts_tenant_operation_attempt_uq unique (tenant_id, operation_id, attempt),
  constraint sync_attempts_tenant_operation_fk
    foreign key (tenant_id, operation_id) references sync_operations (tenant_id, id)
);

create index sync_attempts_tenant_created_idx on sync_attempts (tenant_id, created_at);
create index sync_attempts_operation_idx on sync_attempts (tenant_id, operation_id, created_at);

-- Audit history is evidence, so mutation is rejected at the database boundary.
create or replace function prevent_audit_events_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function prevent_audit_events_mutation();

comment on table inbox_messages is
  'Durable integration-event ledger. message_id is the source delivery identifier; status maps to event state.';
comment on column inbox_messages.observed_at is
  'Trusted receive observation time used for freshness and reconciliation windows.';
comment on column inbox_messages.payload is
  'Validated event payload; raw provider request bodies are not stored here.';
comment on table sync_operations is
  'Tenant-scoped business operation ledger. idempotency_key is independent from source delivery deduplication.';
comment on column sync_operations.last_error_message is
  'Safe, redacted operator-facing error summary; never a provider payload or credential.';
comment on table sync_attempts is
  'Per-operation provider attempt metadata with safe HTTP and error evidence.';
