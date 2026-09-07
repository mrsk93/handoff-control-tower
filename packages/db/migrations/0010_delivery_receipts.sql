create table outbox_delivery_receipts (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  outbox_id uuid not null references outbox_messages(id),
  attempt_count integer not null,
  remote_receipt_id text not null,
  idempotency_key text not null,
  correlation_id text not null,
  causation_id text,
  accepted_at timestamptz not null,
  duplicate boolean not null default false,
  created_at timestamptz not null,
  unique (tenant_id, outbox_id, attempt_count)
);

create index outbox_delivery_receipts_tenant_outbox_idx
  on outbox_delivery_receipts (tenant_id, outbox_id, created_at);
