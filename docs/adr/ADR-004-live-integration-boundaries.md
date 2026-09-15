# ADR-004: Live integration boundaries and safe defaults

## Status

Accepted for the sandbox vertical slice. Provider-specific capability and credential
facts remain verification gates in their respective integration tickets.

## Context

The deterministic runtime already has a PostgreSQL inbox/outbox, tenant-scoped
records, mock adapters, and an operator surface. The live slice adds Shopify,
ERPNext, and ShipBob without weakening those guarantees or making external
systems part of a database transaction. The source plan also leaves several
choices open that would otherwise be rediscovered by every adapter and workflow.

## Decisions

### Durable work

PostgreSQL remains the durable source of truth for inbox messages, business
idempotency, outbox records, leases, attempts, and dead letters. A lightweight
polling worker may use Redis for liveness or rate-limit coordination, but Redis
or a queue library cannot replace the committed outbox or its recovery path.

### Identity and idempotency

Canonical records use internal UUIDs. Vendor identifiers, including Shopify GIDs,
remain opaque strings. An external reference is scoped by tenant, connection,
system, resource, and external ID. Delivery idempotency uses the tenant, source,
and provider delivery ID. Business effects use the canonical aggregate and
semantic revision. Adapters must read by stable reference before creating a
remote record and must never derive an idempotency key from a mutable display
label.

### Quantities and money

The initial live catalog accepts integer `EA` quantities only. The canonical
model stores the explicit unit and rejects unsupported conversions. Money is an
integer minor-unit amount paired with an ISO currency code. Existing mock integer
quantities remain valid under this representation.

### ERPNext transaction policy

The integration creates Sales Orders and Delivery Notes as drafts by default.
Submission is disabled unless a later, explicitly approved policy enables it
after a disposable-site preflight. The Tower never creates accounting invoices.

### Inventory ownership

ShipBob is authoritative for physical 3PL execution and fulfillment-center
balances. ERPNext is retained as accounting/ERP stock evidence. The Tower stores
both views, reports divergence, and does not auto-adjust either system in the MVP.

### Privacy and replay

Ordinary logs, audit metadata, exceptions, and operator read models contain only
minimum operational fields and redacted PII. Raw webhook bodies are not retained
by default. If an incident requires replay and ID-based rehydration is unsafe,
the system may place an encrypted, access-controlled body in a short-lived
replay store with an explicit expiry and purge record. Credentials and signed
headers are never logged.

### Operator access

Public vendor webhook routes are separate from the operator surface. A public
tunnel may terminate only verified provider deliveries. Operator reads and
commands require an authenticated tenant-aware principal; the current synthetic
principal is permitted only in mock/test mode and cannot be used as production
authentication.

## Consequences

- Remote I/O stays outside PostgreSQL transactions and is safe to retry.
- The mock path remains credential-free, deterministic, and suitable for CI and
  demos.
- Live adapters must expose capability failures as explicit configuration or
  health errors instead of silently falling back to mocks.
- Inventory mismatches and disputed values remain evidence-backed operator work;
  automatic stock adjustment is outside the MVP.
- A submitted ERPNext document, arbitrary unit conversion, or raw PII replay
  requires a separate decision and ticket.

## Verification gates

Provider tickets must attach current, redacted account evidence for API version,
scopes, endpoint, authentication, lookup semantics, webhook proof, and supported
sandbox operations. Offline contract tests must pass without credentials, and
the mock provider path must remain available in every local and CI profile.
