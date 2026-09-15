alter table sync_operations add column command_hash text;
alter table sync_operations add column result jsonb;
alter table sync_operations add column remote_id text;
alter table sync_operations add column locked_at timestamptz;
alter table sync_operations add column locked_by text;
alter table sync_operations add column lease_token uuid;

create index sync_operations_lease_idx
  on sync_operations (tenant_id, status, locked_at);

comment on column sync_operations.command_hash is
  'Stable fingerprint of the business command; a reused idempotency key with a different hash is rejected.';
comment on column sync_operations.result is
  'Redacted, provider-neutral completion result retained for idempotent replay and operator evidence.';
comment on column sync_operations.remote_id is
  'Opaque remote identifier returned by a completed operation.';
comment on column sync_operations.lease_token is
  'Fencing token for the current worker claim; stale workers cannot record outcomes.';
