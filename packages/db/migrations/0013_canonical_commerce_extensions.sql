create table catalog_items (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  sku text not null,
  normalized_sku text not null,
  name text not null,
  barcode text,
  active boolean not null default true,
  requires_shipping boolean not null default true,
  unit text not null default 'EA',
  weight jsonb,
  dimensions jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, normalized_sku),
  check (length(trim(sku)) > 0),
  check (length(trim(normalized_sku)) > 0),
  check (unit in ('EA', 'KG', 'LB', 'CASE', 'UNKNOWN'))
);

create index catalog_items_tenant_idx on catalog_items (tenant_id);

create table customers (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  email text,
  display_name text not null,
  phone text,
  billing_address jsonb,
  shipping_addresses jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (jsonb_typeof(shipping_addresses) = 'array')
);

create index customers_tenant_idx on customers (tenant_id);

alter table orders add column customer_id uuid references customers(id);
alter table orders add column lifecycle_status text;
alter table orders add column financial_status text;
alter table orders add column requested_shipping_method text;
alter table orders add column shipping_address jsonb;
alter table orders add column billing_address jsonb;
alter table orders add column subtotal_minor bigint;
alter table orders add column shipping_total_minor bigint;
alter table orders add column tax_total_minor bigint;
alter table orders add column discount_total_minor bigint;
alter table orders add column grand_total_minor bigint;
alter table orders add column source_updated_at timestamptz;
alter table orders add column observed_at timestamptz;
create unique index orders_tenant_order_number_uq on orders (tenant_id, order_number);
alter table orders add constraint orders_money_nonnegative_ck check (
  (subtotal_minor is null or subtotal_minor >= 0) and
  (shipping_total_minor is null or shipping_total_minor >= 0) and
  (tax_total_minor is null or tax_total_minor >= 0) and
  (discount_total_minor is null or discount_total_minor >= 0) and
  (grand_total_minor is null or grand_total_minor >= 0)
);

alter table order_lines add column line_number text;
alter table order_lines add column sku_id uuid references catalog_items(id);
alter table order_lines add column title text;
alter table order_lines add column unit text;
alter table order_lines add column ordered_quantity jsonb;
alter table order_lines add column unit_price_minor bigint;
alter table order_lines add column discount_total_minor bigint;
alter table order_lines add column tax_total_minor bigint;
create unique index order_lines_order_line_number_uq on order_lines (order_id, line_number)
  where line_number is not null;
alter table order_lines add constraint order_lines_quantity_object_ck check (
  ordered_quantity is null or jsonb_typeof(ordered_quantity) = 'object'
);
alter table order_lines add constraint order_lines_money_nonnegative_ck check (
  (unit_price_minor is null or unit_price_minor >= 0) and
  (discount_total_minor is null or discount_total_minor >= 0) and
  (tax_total_minor is null or tax_total_minor >= 0)
);

alter table fulfillments add column provider text not null default 'wms';
alter table fulfillments drop constraint if exists fulfillments_tenant_id_order_id_key;
create unique index fulfillments_tenant_order_provider_uq
  on fulfillments (tenant_id, order_id, provider);
create unique index fulfillments_tenant_provider_external_uq
  on fulfillments (tenant_id, provider, warehouse_order_id)
  where warehouse_order_id is not null;

alter table shipments add column fulfillment_id uuid references fulfillments(id);
alter table shipments add column provider text not null default 'wms';
alter table shipments add column delivered_at timestamptz;
alter table shipments add column source_updated_at timestamptz;
alter table shipments add column observed_at timestamptz;
create unique index shipments_tenant_provider_external_uq
  on shipments (tenant_id, provider, external_shipment_id)
  where external_shipment_id is not null;
create index shipments_fulfillment_idx on shipments (tenant_id, fulfillment_id);
