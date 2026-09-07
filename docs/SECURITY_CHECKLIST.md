# Security and privacy checklist

This evidence is for the synthetic portfolio runtime. It describes audit-ready patterns, not
regulatory compliance or certification.

| Control                                  | Evidence                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant context comes from authentication | Operator routes resolve a non-production synthetic principal from trusted headers; the body cannot set tenant context. Production rejects the synthetic authentication seam until an external adapter is supplied. Ingress uses a source-specific HMAC over the raw body. |
| Repository tenant scope                  | Repository helpers require `TenantContext`; cross-tenant reads return no data and writes carry tenant predicates.                                                                                                                                                         |
| Signature and replay protection          | Mock ingress verifies raw-body HMAC signatures, and inbox uniqueness covers source/message and idempotency keys.                                                                                                                                                          |
| Body limits and runtime validation       | `INGEST_MAX_BODY_BYTES` is enforced before parsing; mock ingress uses runtime envelope validation.                                                                                                                                                                        |
| Credential protection                    | `CredentialCipher` exposes AES-256-GCM encrypt/decrypt with tenant/system associated data. The application provider derives its key from `CREDENTIAL_ENCRYPTION_SECRET`; plaintext credentials are not seeded or returned.                                                |
| Log allowlist/redaction                  | `StructuredLogger` emits only approved identifiers and bounded fields. Payloads, secrets, raw adapter errors, and credential values are omitted.                                                                                                                          |
| Operator authorization                   | Viewer, operator, and admin roles have separate read, command, and simulator permissions. Named commands require an operator principal.                                                                                                                                   |
| Rate limiting                            | Ingress, named commands, dead-letter retry, and reconciliation use fixed-window limits. Runtime requests use Redis; direct deterministic tests use an in-memory adapter.                                                                                                  |
| Append-only audit                        | PostgreSQL triggers reject update/delete on `audit_events`; exception commands retain actor, correlation, and causation identifiers.                                                                                                                                      |
| Safe errors                              | The HTTP filter returns a stable error code and correlation ID while logs retain only error class and route metadata.                                                                                                                                                     |
| Dependency and secret scanning           | CI runs `pnpm security:scan`, `pnpm audit --audit-level=high`, and the repository secret-scan action.                                                                                                                                                                     |
| Simulator guard                          | The simulator is disabled in production and additionally requires the admin role outside production.                                                                                                                                                                      |
| Billing boundary                         | Only guarded invoice-eligibility events are emitted; no accounting invoice is created.                                                                                                                                                                                    |
| Synthetic data                           | Fixtures and seeds use synthetic tenant, order, identifier, and example-domain data only; no payment/card data is present.                                                                                                                                                |

## Identifier chain

The durable chain is `inbox message → command/audit correlation → outbox message → delivery receipt`.
Each stage is tenant-scoped and preserves stable `idempotencyKey`, `correlationId`, and
`causationId` values. `outbox_delivery_receipts` retains the adapter receipt after remote I/O
returns. Delivery remains at least once; a receipt is evidence of an attempt, not an exactly-once
transport claim.
