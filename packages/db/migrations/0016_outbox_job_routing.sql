alter table outbox_messages add column job_type text;
create index outbox_job_route_idx on outbox_messages (tenant_id, job_type, available_at);

comment on column outbox_messages.job_type is
  'Logical internal route for durable catalog, order, fulfillment or reconciliation jobs.';
