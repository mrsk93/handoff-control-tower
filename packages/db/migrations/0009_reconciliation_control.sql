create table reconciliation_leases (
  tenant_id uuid not null references tenants(id),
  system_pair text not null,
  resource_type text not null,
  locked_by text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, system_pair, resource_type)
);

create index reconciliation_leases_expiry_idx on reconciliation_leases (locked_until);

create table reconciliation_watermarks (
  tenant_id uuid not null references tenants(id),
  system_pair text not null,
  resource_type text not null,
  last_window_end timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, system_pair, resource_type)
);

alter table reconciliation_runs
  add constraint reconciliation_runs_window_ck check (window_start < window_end);

create index reconciliation_runs_tenant_created_idx
  on reconciliation_runs (tenant_id, created_at desc);
create index reconciliation_findings_run_idx
  on reconciliation_findings (tenant_id, run_id, created_at);
