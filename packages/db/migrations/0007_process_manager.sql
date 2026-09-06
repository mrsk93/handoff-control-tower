alter table orders drop constraint if exists orders_release_status_ck;
alter table orders drop constraint if exists orders_release_status_check;
alter table orders add constraint orders_release_status_ck
  check (release_status in ('pending', 'released', 'held', 'cancel_requested', 'cancelled', 'exception'));

alter table shipments add column source_shipment_id text;
create unique index shipments_tenant_source_id_uq
  on shipments (tenant_id, source_shipment_id)
  where source_shipment_id is not null;
