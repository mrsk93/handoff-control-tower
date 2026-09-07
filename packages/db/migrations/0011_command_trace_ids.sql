alter table exception_commands add column correlation_id text;
alter table exception_commands add column causation_id text;

create index exception_commands_trace_idx
  on exception_commands (tenant_id, correlation_id, created_at);
