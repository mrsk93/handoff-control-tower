create table audit_events (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  actor_type text not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  correlation_id text,
  causation_id text,
  before_summary jsonb,
  after_summary jsonb,
  created_at timestamptz not null
);

create index audit_events_tenant_created_idx on audit_events (tenant_id, created_at);
create index audit_events_entity_idx on audit_events (tenant_id, entity_type, entity_id);

create or replace function reject_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_no_update
before update or delete on audit_events
for each row execute function reject_audit_mutation();
