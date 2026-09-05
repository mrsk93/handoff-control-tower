create table exceptions (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  order_id uuid references orders(id),
  process_instance_id uuid references process_instances(id),
  order_line_id uuid references order_lines(id),
  shipment_id uuid references shipments(id),
  type text not null,
  severity text not null,
  status text not null,
  active_key text,
  machine_summary text not null,
  operator_details text,
  evidence jsonb not null default '{}'::jsonb,
  assignee text,
  resolution_code text,
  resolution_reason text,
  resolved_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index exceptions_active_key_uq on exceptions (tenant_id, active_key) where active_key is not null and status = 'open';
create index exceptions_tenant_status_idx on exceptions (tenant_id, status);
create index exceptions_order_idx on exceptions (tenant_id, order_id);

create table reconciliation_runs (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  system_pair text not null,
  resource_type text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null,
  page_cursor text,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  completed_at timestamptz
);

create index reconciliation_runs_tenant_idx on reconciliation_runs (tenant_id);

create table reconciliation_findings (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  run_id uuid not null references reconciliation_runs(id),
  category text not null,
  resource_type text not null,
  resource_key text not null,
  source_values jsonb not null default '{}'::jsonb,
  recommended_action text,
  repair_status text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  unique (run_id, resource_type, resource_key, category)
);

create index reconciliation_findings_tenant_idx on reconciliation_findings (tenant_id);
