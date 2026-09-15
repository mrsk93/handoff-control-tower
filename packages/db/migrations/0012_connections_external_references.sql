alter type connection_system_type add value if not exists 'erp';
create type connection_environment as enum ('mock', 'sandbox', 'production');

alter table connections add column environment connection_environment not null default 'mock';
alter table connections drop constraint if exists connections_tenant_id_system_type_key;
create unique index connections_tenant_system_environment_uq
  on connections (tenant_id, system_type, environment);
create unique index connections_tenant_id_id_uq on connections (tenant_id, id);

create table external_references (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  connection_id uuid not null references connections(id),
  system_type text not null,
  resource_type text not null,
  external_id text not null,
  canonical_type text not null,
  canonical_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint external_references_tenant_system_resource_external_uq
    unique (tenant_id, system_type, resource_type, external_id),
  constraint external_references_tenant_connection_canonical_uq
    unique (tenant_id, connection_id, system_type, resource_type, canonical_type, canonical_id),
  foreign key (tenant_id, connection_id) references connections (tenant_id, id),
  check (length(trim(system_type)) > 0),
  check (length(trim(resource_type)) > 0),
  check (length(trim(external_id)) > 0),
  check (length(trim(canonical_type)) > 0)
);

create index external_references_tenant_idx on external_references (tenant_id);
create index external_references_connection_idx on external_references (tenant_id, connection_id);
