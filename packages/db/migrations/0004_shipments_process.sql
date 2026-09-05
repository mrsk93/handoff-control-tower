create table shipments (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  order_id uuid not null references orders(id),
  external_shipment_id text,
  carrier_code text not null,
  service_code text not null,
  tracking_number text not null,
  tracking_url text,
  shipped_at timestamptz,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index shipments_tenant_tracking_uq on shipments (tenant_id, tracking_number, carrier_code);
create unique index shipments_external_id_uq on shipments (tenant_id, external_shipment_id) where external_shipment_id is not null;
create index shipments_tenant_idx on shipments (tenant_id);

create table shipment_lines (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  shipment_id uuid not null references shipments(id),
  order_line_id uuid not null references order_lines(id),
  quantity integer not null check (quantity >= 0),
  unique (shipment_id, order_line_id)
);

create index shipment_lines_tenant_idx on shipment_lines (tenant_id);

create table process_instances (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  order_id uuid not null references orders(id),
  current_step text not null,
  last_applied_event_version text,
  blocking_exception_count integer not null default 0 check (blocking_exception_count >= 0),
  invoice_eligible boolean not null default false,
  decision_version integer not null default 0 check (decision_version >= 0),
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, order_id)
);

create index process_instances_tenant_idx on process_instances (tenant_id);
