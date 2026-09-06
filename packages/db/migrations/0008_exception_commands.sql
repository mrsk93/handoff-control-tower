alter table exceptions add column row_version integer not null default 1;
alter table exceptions add constraint exceptions_row_version_ck check (row_version > 0);

create table exception_commands (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  exception_id uuid not null references exceptions(id),
  idempotency_key text not null,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  actor_id text not null,
  created_at timestamptz not null,
  unique (tenant_id, idempotency_key)
);

create index exception_commands_exception_idx on exception_commands (tenant_id, exception_id);

create table exception_notes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  exception_id uuid not null references exceptions(id),
  author_id text not null,
  note text not null,
  created_at timestamptz not null
);

create index exception_notes_exception_idx on exception_notes (tenant_id, exception_id, created_at);
