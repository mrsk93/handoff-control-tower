create table orders (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  source text not null,
  source_order_id text not null,
  source_version text not null,
  order_number text not null,
  currency text not null,
  accepted_at timestamptz not null,
  cancelled_at timestamptz,
  release_status text not null check (release_status in ('pending', 'released', 'held', 'cancelled')),
  canonical_hash text not null,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, source_order_id)
);

create index orders_tenant_idx on orders (tenant_id);

create table order_lines (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  order_id uuid not null references orders(id),
  source_line_id text not null,
  sku text not null,
  ordered_qty integer not null check (ordered_qty >= 0),
  cancelled_qty integer not null default 0 check (cancelled_qty >= 0 and cancelled_qty <= ordered_qty),
  unique (order_id, source_line_id)
);

create index order_lines_tenant_idx on order_lines (tenant_id);

create table fulfillments (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  order_id uuid not null references orders(id),
  warehouse_order_id text,
  status text not null,
  source_version text,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, order_id)
);

create index fulfillments_tenant_idx on fulfillments (tenant_id);

create table fulfillment_lines (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  fulfillment_id uuid not null references fulfillments(id),
  order_line_id uuid not null references order_lines(id),
  allocated_qty integer not null default 0 check (allocated_qty >= 0),
  picked_qty integer not null default 0 check (picked_qty >= 0),
  packed_qty integer not null default 0 check (packed_qty >= 0),
  shipped_qty integer not null default 0 check (shipped_qty >= 0),
  short_qty integer not null default 0 check (short_qty >= 0),
  damaged_qty integer not null default 0 check (damaged_qty >= 0),
  unique (fulfillment_id, order_line_id)
);

create index fulfillment_lines_tenant_idx on fulfillment_lines (tenant_id);
