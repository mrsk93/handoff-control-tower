create extension if not exists pgcrypto;

create type tenant_status as enum ('active', 'suspended');
create type connection_system_type as enum ('commerce', 'wms', 'carrier', 'billing');
create type connection_status as enum ('active', 'disabled', 'error', 'reauth_required');

create table tenants (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  status tenant_status not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table connections (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  system_type connection_system_type not null,
  adapter_key text not null,
  status connection_status not null default 'active',
  encrypted_credentials bytea,
  config jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, system_type)
);

create index connections_tenant_idx on connections (tenant_id);
