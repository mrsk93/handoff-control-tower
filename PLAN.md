# Reliable Order-to-Fulfillment Sync — Implementation Plan

## 0. Document contract

This is the authoritative implementation plan for a standalone portfolio system named **Handoff Control Tower**.

It demonstrates a reliable operational path across commerce, warehouse, carrier, and billing boundaries:

`order accepted → warehouse released → picked/short-shipped → shipped → tracking synchronized → invoice eligible`

The coding agent must read this document completely, implement milestones in order, and preserve a deterministic all-mock execution path. Proprietary WMS/TMS capabilities must never be invented.

### Required operating rules

1. Inspect the repository before modifying it.
2. Do not overwrite unrelated or user-authored changes.
3. Update `docs/IMPLEMENTATION_STATUS.md` after each milestone.
4. Put every external system behind a versioned adapter interface.
5. Use synthetic businesses, people, SKUs, orders, addresses, and tracking data.
6. Never describe mock adapters as ShipHero, Extensiv, Logiwa, CargoWise, Manhattan, NetSuite, QuickBooks, or another real product.
7. Do not add a real vendor connector unless valid official documentation and authorized credentials are supplied.
8. Prefer correctness, explainability, and recoverability over feature count.

### Stop conditions

Stop and request developer input if:

- a destructive migration would touch non-demo data;
- an adapter contract cannot represent an explicit business case in this plan;
- a real platform requires credentials, protected scopes, paid access, or agreement acceptance;
- the system-of-record choice becomes ambiguous for a mutation;
- invoice eligibility could be interpreted as creating an accounting invoice rather than emitting a guarded readiness event;
- a benchmark result is unstable or a critical failure scenario is not reproducible.

---

## 1. Portfolio purpose

### Buyer-facing problem

Most integration failures are not missing API calls. They are ownership and state problems at handoffs:

- the same order is sent twice;
- a warehouse update arrives before its acknowledgment;
- a partial shipment is treated as a complete shipment;
- a tracking update is lost;
- a cancelled or held order continues toward billing;
- Shopify, the WMS, and finance disagree and nobody can see why.

### Demonstrated capability

The finished project must prove that Sumit can:

- map system-of-record ownership by field and state;
- normalize data from incompatible systems;
- use inbox/outbox and idempotency patterns;
- coordinate a long-running workflow without pretending to have a distributed transaction;
- handle duplicates, out-of-order messages, partial fulfillment, cancellation and holds;
- reconcile remote and local state;
- prevent billing readiness when quantities or states disagree;
- expose an actionable exception queue and audit trail;
- design adapters that can later be replaced by real WMS/carrier/accounting connectors.

### Truthful positioning statement

> A production-style portfolio demonstration of the order-to-fulfillment handoff across a commerce platform, WMS, carrier and billing gate. Vendor integrations are deterministic mocks; the reliability, orchestration, exception and reconciliation logic is implemented and tested.

### Upwork portfolio copy after completion

**Title, maximum 70 characters**

`Reliable Shopify-to-Warehouse Fulfillment Integration`

**Role, maximum 100 characters**

`Integration engineer — canonical data, workflow orchestration, retries and reconciliation`

**Description target, maximum 600 characters**

> Built a production-style control tower for the order → warehouse → carrier → billing handoff. The system normalizes events, uses inbox/outbox delivery, prevents duplicate effects, handles partial and out-of-order updates, and blocks invoice readiness when quantities or exceptions disagree. Operators can inspect, resolve and replay exceptions, while reconciliation detects drift. Runs with deterministic Shopify/WMS/carrier mocks and synthetic data; no proprietary vendor access is claimed.

**Five tags**

`API Integration`, `Order Management`, `Inventory Management`, `Node.js`, `PostgreSQL`

---

## 2. Product scenario

### Synthetic company

`Northstar Fulfillment Demo` operates one ecommerce store and one warehouse. It sends accepted orders to a WMS, receives warehouse status events, requests a carrier label after a packable shipment is ready, writes tracking/fulfillment status back to commerce, and emits an `InvoiceEligible` event only when operational evidence agrees.

### Primary happy path

1. Commerce emits `OrderCreated`.
2. Control Tower validates and stores it.
3. Order passes release policy.
4. Outbox sends `CreateWarehouseOrder` to WMS.
5. WMS returns acknowledgment.
6. WMS emits picked/packed quantities.
7. Carrier adapter creates a synthetic shipment/tracking reference.
8. WMS or carrier confirms shipment.
9. Control Tower updates commerce fulfillment through its adapter.
10. Reconciliation confirms shipped quantities and tracking.
11. Billing gate emits `InvoiceEligible` with supporting evidence.

### Required exception path

The demo order contains two lines. The WMS short-ships one unit on line two. The system must:

- preserve actual quantities;
- create an exception;
- allow the shipped portion to be synchronized correctly;
- prevent a full-order invoice-ready event;
- show why it is blocked;
- accept an operator decision to backorder or close short;
- recompute eligibility deterministically;
- retain a complete audit trail.

---

## 3. Scope

### MVP — required

1. Multi-tenant-ready domain model with one seeded tenant and isolation tests using a second tenant.
2. Four adapter ports:
   - commerce;
   - warehouse;
   - carrier;
   - billing-event sink.
3. Deterministic mock implementation for all adapters.
4. Optional Shopify development-store adapter for inbound order/read-back only.
5. Canonical order, fulfillment and shipment models.
6. Durable inbound event inbox.
7. Transactional outbox and dispatcher.
8. Long-running fulfillment process manager.
9. State machines with guarded transitions.
10. Idempotent inbound and outbound effects.
11. Retry, dead-letter and replay controls.
12. Exception queue with assignment, notes and resolution actions.
13. Scheduled/manual reconciliation.
14. Billing eligibility gate; no real invoice creation.
15. Operator UI and audit timeline.
16. Synthetic event/failure simulator.
17. Unit, database, contract, end-to-end and chaos-scenario tests.
18. Docker Compose, CI, runbook and portfolio kit.

### Non-goals

- No proprietary WMS connector.
- No real shipping-label purchase.
- No live carrier tracking calls.
- No inventory forecasting.
- No returns/reverse logistics in MVP.
- No accounting invoice creation or payment handling.
- No EDI translator in MVP.
- No AI/LLM in this project.
- No Kubernetes or Kafka.
- No promise of exactly-once transport.

### Stretch goals, only after release

- EDI 940/945 fixture adapter.
- CSV/SFTP warehouse adapter.
- One official sandbox connector where access exists.
- Returns flow.
- Multi-warehouse split allocation.
- Operational SLA alerts.

---

## 4. Success criteria

### Functional

- Duplicate inbound events produce one business effect.
- Duplicate outbox dispatch attempts produce one remote effect in the deterministic mock.
- Events arriving before their prerequisite are parked and later applied or escalated; they never force an invalid transition.
- Partial shipment quantities remain distinct from ordered quantities.
- Cancellation after warehouse release becomes an explicit compensating request/exception, not a database rollback fiction.
- Invoice eligibility is false while any blocking exception or quantity mismatch exists.
- Reconciliation detects a deliberately missing carrier/commerce update.
- Operator resolution changes state only through an allowed command.
- Every state mutation is attributable to a source event, system action, or operator action.
- Cross-tenant access and mutation attempts fail.

### Synthetic targets

| Measure | Target | Test |
| --- | ---: | --- |
| Duplicate business effects | 0 | 1,000-event duplicate pack |
| Lost acknowledged inbound events | 0 | accepted vs persisted assertion |
| Invalid state transitions | 0 committed | property/scenario tests |
| Outbox eventual delivery | 100% after transient mock failures | dispatcher scenario |
| Reconciliation detection | 100% of seeded drift cases | drift fixture suite |
| Incorrect `InvoiceEligible` emissions | 0 | policy truth-table suite |
| Exception traceability | 100% linked to evidence | DB integrity test |

Publish these only as synthetic test results with the fixture count and environment.

---

## 5. System ownership map

This map controls write behavior. It must be encoded in `docs/SYSTEM_OF_RECORD.md` and reflected in tests.

| Data/state | Authoritative source | Local role | Allowed outbound target |
| --- | --- | --- | --- |
| order identity and accepted lines | Commerce at acceptance | immutable canonical snapshot + revisions | WMS |
| fraud/payment release flag | Commerce | release policy input | WMS hold/release request |
| warehouse order acknowledgment | WMS | process state | Commerce/operator display only |
| allocated/picked/packed quantities | WMS | fulfillment actuals | Commerce and billing gate |
| short/over/damaged quantity | WMS | exception evidence | Operator/billing gate |
| label and tracking number | Carrier adapter | shipment evidence | WMS/Commerce |
| ship confirmation time | WMS or carrier, configured explicitly | canonical shipment state | Commerce/billing gate |
| commerce fulfillment record | Commerce | remote confirmation/read-back | reconciliation |
| invoice eligibility decision | Control Tower policy | derived state/event | billing-event sink |
| actual accounting invoice | External accounting system | out of scope | none |

If two sources can confirm shipment, configure one as authoritative and the other as corroborating. Never merge timestamps silently.

---

## 6. Architecture

### Stack

| Concern | Choice |
| --- | --- |
| Backend | NestJS or framework-light Node.js service in strict TypeScript |
| UI | Next.js/React operator console |
| Database | PostgreSQL |
| Queue | BullMQ + Redis |
| Validation | Zod or equivalent runtime schemas |
| Data access | Drizzle or Prisma, chosen once in ADR-001 |
| API | REST for operator commands/queries; internal typed messages |
| Tests | Vitest/Jest, Testcontainers, Playwright, property-based library, k6 optional |
| Observability | structured logs, correlation/causation IDs, metrics |
| Local runtime | Docker Compose |

### Topology

```mermaid
flowchart TD
    C["Commerce Adapter"] --> I["Inbox"]
    W["WMS Adapter"] --> I
    R["Carrier Adapter"] --> I
    I --> P["Fulfillment Process Manager"]
    P --> O["Transactional Outbox"]
    O --> C
    O --> W
    O --> R
    P --> E["Exception Queue"]
    P --> B["Billing Eligibility Gate"]
    E --> U["Operator Console"]
    B --> O
```

### Core pattern

- Transport is at least once.
- Each inbound message is stored before processing.
- Domain mutation and outbound message creation commit in the same PostgreSQL transaction.
- A dispatcher delivers outbox rows after commit.
- Remote side effects carry a stable idempotency key where supported.
- Where a vendor lacks idempotency support, the adapter performs read-before-create or stable external-reference lookup and documents residual risk.
- The process manager coordinates state; it does not hold a cross-system transaction.

---

## 7. Repository structure

```text
.
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── ingestion/
│   │       │   ├── orders/
│   │       │   ├── fulfillment/
│   │       │   ├── exceptions/
│   │       │   ├── reconciliation/
│   │       │   └── audit/
│   │       └── main.ts
│   ├── worker/
│   │   └── src/
│   │       ├── inbox.processor.ts
│   │       ├── outbox.dispatcher.ts
│   │       └── reconciliation.scheduler.ts
│   ├── simulator/
│   │   └── src/
│   └── web/
│       └── src/
├── packages/
│   ├── domain/
│   │   ├── commands/
│   │   ├── events/
│   │   ├── models/
│   │   ├── policies/
│   │   ├── process-manager/
│   │   └── state-machines/
│   ├── adapters/
│   │   ├── contracts/
│   │   ├── mock-commerce/
│   │   ├── mock-wms/
│   │   ├── mock-carrier/
│   │   └── mock-billing/
│   ├── db/
│   ├── queue/
│   ├── observability/
│   └── shared-testkit/
├── tests/
│   ├── scenarios/
│   ├── contracts/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── docs/
│   ├── adr/
│   ├── portfolio/
│   ├── SYSTEM_OF_RECORD.md
│   ├── FIELD_MAPPING.md
│   ├── EVENT_CATALOG.md
│   ├── RUNBOOK.md
│   └── IMPLEMENTATION_STATUS.md
├── scripts/
│   ├── seed-demo.ts
│   ├── run-scenario.ts
│   └── verify-invariants.ts
├── docker-compose.yml
├── .env.example
└── README.md
```

Use a workspace package manager. Domain package cannot import framework, ORM, Redis, Shopify, or HTTP types.

---

## 8. Canonical data model

### Canonical order

```ts
type CanonicalOrder = {
  tenantId: string;
  orderId: string;
  source: "commerce";
  sourceOrderId: string;
  sourceVersion: string;
  orderNumber: string;
  currency: string;
  acceptedAt: string;
  cancelledAt?: string;
  releaseStatus: "pending" | "released" | "held" | "cancelled";
  lines: CanonicalOrderLine[];
};

type CanonicalOrderLine = {
  lineId: string;
  sourceLineId: string;
  sku: string;
  orderedQty: number;
  cancelledQty: number;
};
```

### Fulfillment actuals

```ts
type FulfillmentActual = {
  orderId: string;
  warehouseOrderId?: string;
  status:
    | "not_sent"
    | "sent"
    | "acknowledged"
    | "picking"
    | "packed"
    | "partially_shipped"
    | "shipped"
    | "cancel_requested"
    | "cancelled"
    | "exception";
  lines: Array<{
    lineId: string;
    allocatedQty: number;
    pickedQty: number;
    packedQty: number;
    shippedQty: number;
    shortQty: number;
    damagedQty: number;
  }>;
  version: number;
};
```

### Quantity invariants

For every line:

- all quantities are integers greater than or equal to zero;
- `cancelledQty <= orderedQty`;
- `allocatedQty <= orderedQty - cancelledQty` unless an explicit overage exception exists;
- `pickedQty <= allocatedQty`;
- `packedQty <= pickedQty`;
- `shippedQty <= packedQty`;
- `shortQty` is evidence, not a subtraction applied repeatedly;
- computed open quantity is derived from immutable order and confirmed shipped/cancelled quantities.

Reject or quarantine an event that violates invariants. Do not clamp values silently.

### Shipment

```ts
type Shipment = {
  shipmentId: string;
  orderId: string;
  externalShipmentId?: string;
  carrierCode: string;
  serviceCode: string;
  trackingNumber: string;
  trackingUrl?: string;
  shippedAt?: string;
  lines: Array<{ lineId: string; quantity: number }>;
  status: "label_created" | "shipped" | "in_transit" | "delivered" | "voided";
};
```

---

## 9. State machines

### Order release state

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Released: release checks pass
    Pending --> Held: hold signal
    Held --> Released: operator/system releases
    Pending --> Cancelled: commerce cancellation
    Held --> Cancelled: commerce cancellation
    Released --> CancelRequested: cancellation after WMS send
    CancelRequested --> Cancelled: WMS confirms
    CancelRequested --> Exception: WMS cannot cancel
```

### Fulfillment state

```mermaid
stateDiagram-v2
    [*] --> NotSent
    NotSent --> Sent: outbox dispatch
    Sent --> Acknowledged: WMS ack
    Acknowledged --> Picking: pick started
    Picking --> Packed: all packable qty packed
    Picking --> Exception: short or damage
    Packed --> Shipped: ship confirmation
    Packed --> PartiallyShipped: subset shipped
    PartiallyShipped --> Shipped: remaining qty shipped or closed
    Exception --> Picking: resolution resumes
    Exception --> PartiallyShipped: close short
```

### Transition rules

- State is derived/advanced through domain commands, never by controller assignment.
- Every command checks current state, source version, tenant and invariants.
- Same command with the same idempotency key returns the prior result.
- Older source versions are recorded as stale and ignored.
- Unknown prerequisite events are parked for a bounded time; they are not discarded.
- Manual overrides require a reason and create an audit event.

---

## 10. Event catalog

### Envelope

```ts
type IntegrationEvent<T> = {
  messageId: string;
  eventType: string;
  eventVersion: number;
  tenantId: string;
  sourceSystem: string;
  sourceEntityId: string;
  sourceVersion?: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  payload: T;
};
```

### Inbound events

- `commerce.order.created.v1`
- `commerce.order.updated.v1`
- `commerce.order.cancelled.v1`
- `wms.order.acknowledged.v1`
- `wms.pick.started.v1`
- `wms.pick.completed.v1`
- `wms.order.held.v1`
- `wms.order.short_shipped.v1`
- `wms.shipment.confirmed.v1`
- `carrier.label.created.v1`
- `carrier.tracking.updated.v1`

### Domain events

- `order.accepted.v1`
- `order.release_approved.v1`
- `order.release_held.v1`
- `warehouse_order.requested.v1`
- `warehouse_order.acknowledged.v1`
- `fulfillment.exception_opened.v1`
- `fulfillment.exception_resolved.v1`
- `shipment.ready.v1`
- `shipment.confirmed.v1`
- `commerce_fulfillment.sync_requested.v1`
- `commerce_fulfillment.synced.v1`
- `billing.invoice_eligible.v1`
- `billing.invoice_blocked.v1`

### Commands/outbound messages

- `wms.create_order.v1`
- `wms.cancel_order.v1`
- `carrier.create_label.v1`
- `commerce.upsert_fulfillment.v1`
- `billing.mark_invoice_eligible.v1`

Every event type requires a JSON schema, example fixture, versioning note and owner in `docs/EVENT_CATALOG.md`.

---

## 11. Database design

### Core tables

#### `tenants`

- `id UUID PRIMARY KEY`
- `slug TEXT UNIQUE NOT NULL`
- `name TEXT NOT NULL`
- `status ENUM(active, suspended)`
- timestamps

#### `connections`

- `id UUID PRIMARY KEY`
- `tenant_id UUID NOT NULL`
- `system_type ENUM(commerce, wms, carrier, billing)`
- `adapter_key TEXT NOT NULL`
- `status ENUM(active, disabled, error, reauth_required)`
- `encrypted_credentials BYTEA NULL`
- `config JSONB NOT NULL`
- `last_verified_at TIMESTAMPTZ NULL`
- unique `(tenant_id, system_type)` for MVP

#### `inbox_messages`

- `id UUID PRIMARY KEY`
- envelope identity fields;
- `payload JSONB NOT NULL` using synthetic/non-sensitive MVP data;
- `payload_sha256 TEXT NOT NULL`;
- `status ENUM(received, processing, processed, parked, dead_letter, ignored)`;
- `attempt_count` and safe error fields;
- unique `(tenant_id, source_system, message_id)`;
- unique `(tenant_id, idempotency_key)` where semantics permit.

#### `orders`

- internal/source IDs;
- source version;
- release status;
- accepted/cancelled timestamps;
- currency;
- canonical hash;
- optimistic `row_version`;
- unique `(tenant_id, source_order_id)`.

#### `order_lines`

- internal/source IDs;
- SKU;
- ordered/cancelled quantities;
- unique `(order_id, source_line_id)`;
- check constraints for nonnegative quantities.

#### `fulfillments` and `fulfillment_lines`

- warehouse identity and state;
- per-line actual quantities;
- WMS version;
- check constraints for nonnegative values;
- unique order fulfillment for MVP, but schema allows multiple later.

#### `shipments` and `shipment_lines`

- carrier/external identity;
- tracking and status;
- shipped quantities;
- unique `(tenant_id, external_shipment_id)` when present;
- unique `(tenant_id, tracking_number, carrier_code)` for mock mode.

#### `process_instances`

- `order_id` unique for MVP;
- current process step/status;
- last applied event sequence/version;
- blocking exception count;
- invoice eligibility state;
- optimistic version;
- timestamps.

#### `outbox_messages`

- `id UUID PRIMARY KEY`
- tenant, destination, message type/version;
- payload and idempotency key;
- correlation/causation IDs;
- status `pending|dispatching|sent|retry_wait|dead_letter|cancelled`;
- available/locked/sent timestamps;
- attempt count and safe error;
- unique `(tenant_id, destination, idempotency_key)`.

#### `exceptions`

- `id UUID PRIMARY KEY`
- order/process/line/shipment references;
- type, severity, status;
- machine summary and operator-safe details;
- evidence JSONB with source IDs only;
- assignee optional;
- resolution code, reason and timestamp;
- unique active-exception key to prevent duplicates.

#### `reconciliation_runs` and `reconciliation_findings`

- system pair, resource type, immutable time window;
- counts and status;
- finding category, source values, recommended action;
- repair status and evidence.

#### `audit_events`

- tenant, actor type/ID;
- action;
- entity type/ID;
- correlation/causation IDs;
- redacted before/after summary;
- timestamp;
- append-only.

### Transaction boundaries

Inside one database transaction:

- claim inbox row;
- validate/apply domain command;
- update aggregate/process state;
- create exception if needed;
- insert outbox message(s);
- append audit event;
- mark inbox processed.

Remote I/O never occurs inside this transaction.

---

## 12. Adapter contracts

### Common response

```ts
type AdapterResult<T> =
  | { ok: true; value: T; externalRequestId?: string; observedAt: string }
  | {
      ok: false;
      category: "transient" | "throttled" | "auth" | "validation" | "conflict" | "not_found";
      code: string;
      safeMessage: string;
      retryAfterMs?: number;
      externalRequestId?: string;
    };
```

### Commerce port

```ts
interface CommercePort {
  getOrder(ref: TenantOrderRef): Promise<AdapterResult<CommerceOrderSnapshot>>;
  listOrdersUpdatedSince(query: UpdatedSinceQuery): Promise<AdapterResult<Page<CommerceOrderSnapshot>>>;
  upsertFulfillment(command: CommerceFulfillmentCommand): Promise<AdapterResult<RemoteFulfillmentRef>>;
  getFulfillment(ref: RemoteFulfillmentRef): Promise<AdapterResult<CommerceFulfillmentSnapshot>>;
}
```

### Warehouse port

```ts
interface WarehousePort {
  createOrder(command: CreateWarehouseOrder): Promise<AdapterResult<WarehouseOrderRef>>;
  cancelOrder(command: CancelWarehouseOrder): Promise<AdapterResult<WarehouseCancellation>>;
  getOrder(ref: WarehouseOrderRef): Promise<AdapterResult<WarehouseOrderSnapshot>>;
  listOrdersUpdatedSince(query: UpdatedSinceQuery): Promise<AdapterResult<Page<WarehouseOrderSnapshot>>>;
}
```

### Carrier port

```ts
interface CarrierPort {
  createLabel(command: CreateLabelCommand): Promise<AdapterResult<LabelResult>>;
  getShipment(ref: CarrierShipmentRef): Promise<AdapterResult<CarrierShipmentSnapshot>>;
}
```

### Billing sink

```ts
interface BillingEventSink {
  markInvoiceEligible(event: InvoiceEligibleEvent): Promise<AdapterResult<{ receiptId: string }>>;
}
```

The billing sink records readiness only. Its README must state: **No invoice or financial posting is created.**

### Contract test suite

Every adapter implementation must pass shared tests for:

- stable idempotency key behavior;
- correlation propagation;
- not-found;
- validation failure;
- transient failure;
- throttling/retry-after;
- stale version/conflict;
- pagination where supported;
- safe logging/redaction.

---

## 13. Field mapping

Create an explicit `docs/FIELD_MAPPING.md`. Initial mapping:

| Canonical field | Commerce mock | WMS mock | Notes |
| --- | --- | --- | --- |
| `sourceOrderId` | `id` | `client_order_ref` | commerce owns identity |
| `orderNumber` | `name` | `customer_reference` | display only, not idempotency key |
| `sourceLineId` | `line_items[].id` | `lines[].client_line_ref` | preserve stable source ID |
| `sku` | `line_items[].sku` | `lines[].item_code` | missing SKU opens mapping exception |
| `orderedQty` | `line_items[].quantity` | `lines[].requested_qty` | immutable accepted snapshot + revisions |
| `pickedQty` | n/a | `lines[].picked_qty` | WMS owns |
| `packedQty` | n/a | `lines[].packed_qty` | WMS owns |
| `shippedQty` | fulfillment quantity | `lines[].shipped_qty` | reconcile explicitly |
| `trackingNumber` | fulfillment tracking | `shipment.tracking_no` | carrier may be source depending config |

Mapping failures create an exception; they never produce a line with a guessed SKU or quantity.

---

## 14. Process-manager logic

### Order acceptance

1. Validate envelope and event schema.
2. Normalize order IDs and line quantities.
3. If same source version/hash exists, mark duplicate/no-op.
4. If older version, mark stale/no-op.
5. Upsert accepted order revision.
6. Evaluate release policy:
   - not cancelled;
   - payment/release flag acceptable in fixture;
   - all shippable lines have SKU;
   - quantity invariants hold.
7. If approved, create `wms.create_order.v1` outbox row.
8. If blocked, create a specific exception and no WMS request.

### Warehouse acknowledgment

- Resolve using stable client order reference.
- If order not present yet, park message with prerequisite key and retry after order event or short delay.
- If acknowledgment conflicts with a different WMS order ID, open high-severity identity exception.
- Record acknowledgment once.

### Pick/pack updates

- Apply only a newer WMS source version.
- Validate monotonic quantities unless a versioned correction flag is present.
- A decrease without explicit correction opens a conflict exception.
- Short/damaged quantities open or update one active exception per order line/type.

### Shipment

- Verify shipment line totals do not exceed packed quantities.
- Create stable shipment and line records.
- Create commerce fulfillment outbox message.
- Never mark invoice eligible until commerce read-back and policy evaluation pass.

### Cancellation after WMS release

- Transition to `cancel_requested`.
- Emit WMS cancel command.
- If WMS confirms, transition cancelled.
- If WMS says already shipped, open conflict and keep actual shipment evidence.
- Do not erase prior states or pretend the remote transaction rolled back.

---

## 15. Invoice eligibility policy

### Inputs

- order not cancelled, or only non-cancelled quantities considered;
- confirmed shipped quantities by line;
- commerce fulfillment read-back;
- required tracking reference;
- active blocking exceptions;
- configured resolution for short shipment;
- prior eligibility emission version.

### Output

```ts
type InvoiceEligibilityDecision = {
  eligible: boolean;
  scope: "full_order" | "partial_shipment" | "none";
  decisionVersion: number;
  reasons: Array<{
    code: string;
    blocking: boolean;
    lineId?: string;
    evidenceRefs: string[];
  }>;
  computedAt: string;
};
```

### Required rules

1. `eligible=false` if any high-severity unresolved exception exists.
2. `eligible=false` if shipped quantity exceeds packed or ordered net quantity.
3. `eligible=false` if commerce fulfillment does not reflect the shipment after the reconciliation grace window.
4. `full_order` requires all non-cancelled quantity shipped or explicitly resolved as closed-short according to seeded policy.
5. `partial_shipment` is allowed only when tenant policy explicitly enables it.
6. The event idempotency key includes order, decision version and shipment scope.
7. A later correction emits a new decision/revocation event only if the mock billing contract supports it; otherwise open a high-severity exception and never pretend the prior event disappeared.

Create a table-driven truth suite with at least 25 combinations.

---

## 16. Out-of-order and parked messages

### Parking behavior

When prerequisites are missing:

- persist the inbox message;
- mark `parked` with `prerequisite_type` and `prerequisite_key`;
- do not count it as a transient external failure;
- retry when a matching prerequisite is committed;
- also run a low-frequency parked-message sweeper;
- move to an exception after a configurable maximum age.

Examples:

- WMS acknowledgment before commerce order;
- shipment confirmation before pick update;
- carrier tracking update before label/shipment record.

### Ordering rule

Never depend only on arrival order. Use source versions/timestamps plus state preconditions. Timestamps alone do not establish causality when source clocks differ.

---

## 17. Reconciliation

### Reconciliation pairs

1. Commerce order vs canonical order.
2. WMS fulfillment actuals vs canonical fulfillment.
3. Carrier shipment vs canonical shipment.
4. Canonical shipment vs commerce fulfillment read-back.

### Finding categories

- `missing_local`
- `missing_remote`
- `quantity_mismatch`
- `status_mismatch`
- `tracking_mismatch`
- `identity_mismatch`
- `stale_local`
- `stale_remote_or_delayed`
- `unresolvable_conflict`

### Repair policy

| Finding | Automatic? | Action |
| --- | --- | --- |
| missing local from authoritative source | Yes | apply through same domain service |
| stale local with newer authoritative version | Yes | apply through same domain service |
| missing remote outbound effect | Conditional | re-dispatch stable outbox command |
| quantity mismatch | No by default | open exception with evidence |
| tracking mismatch | No by default | source-of-record policy decides recommendation |
| identity mismatch | No | high-severity operator exception |

### Windowing

- immutable run start/end;
- overlapping watermark window;
- page/cursor persisted after each completed page;
- per tenant/system lock;
- watermark advances only for safely enumerated range;
- all repairs idempotent.

### Seeded drift scenarios

- commerce order missing locally;
- WMS shipped quantity locally stale;
- carrier tracking exists but commerce fulfillment missing;
- conflicting tracking number;
- remote resource absent after local outbox says sent.

---

## 18. Exception model and UI actions

### Exception types

- `MISSING_SKU_MAPPING`
- `WAREHOUSE_IDENTITY_CONFLICT`
- `INVALID_QUANTITY`
- `NON_MONOTONIC_WMS_UPDATE`
- `SHORT_SHIPMENT`
- `CANCEL_AFTER_RELEASE`
- `CANCEL_AFTER_SHIPMENT`
- `FULFILLMENT_SYNC_FAILED`
- `TRACKING_MISMATCH`
- `RECONCILIATION_DRIFT`
- `OUTBOX_DEAD_LETTER`
- `PARKED_EVENT_EXPIRED`

### Severity

- `critical`: financial/data corruption risk or cross-tenant/security issue;
- `high`: blocks fulfillment/billing or identity is ambiguous;
- `medium`: recoverable operational mismatch needing action;
- `low`: informational/stale delay not yet blocking.

### Allowed actions

- assign/unassign;
- add internal note;
- retry linked outbox message;
- map missing SKU to an existing canonical item in demo data;
- choose `backorder` or `close_short` for a short shipment;
- accept a specifically documented authoritative value;
- dismiss only low/non-blocking informational finding with reason.

No generic “mark resolved” button may bypass domain preconditions. Every resolution action is a named command and is audited.

---

## 19. HTTP API

### Inbound adapter simulation

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ingest/commerce/events` | signed mock commerce event |
| POST | `/ingest/wms/events` | signed mock WMS event |
| POST | `/ingest/carrier/events` | signed mock carrier event |

Use separate HMAC secrets per mock source. Real adapters follow their platform's current authentication scheme.

### Operator queries

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/overview` | handoff health and counts |
| GET | `/api/orders` | filterable cursor list |
| GET | `/api/orders/:id` | canonical state + timeline |
| GET | `/api/exceptions` | queue and filters |
| GET | `/api/exceptions/:id` | evidence/actions |
| GET | `/api/outbox/:id` | dispatch attempts |
| GET | `/api/reconciliation-runs` | run history |
| POST | `/api/reconciliation-runs` | bounded manual run |

### Operator commands

| Method | Path | Command |
| --- | --- | --- |
| POST | `/api/exceptions/:id/assign` | assign |
| POST | `/api/exceptions/:id/notes` | add note |
| POST | `/api/exceptions/:id/resolve-short` | backorder or close short |
| POST | `/api/outbox/:id/retry` | safe retry |
| POST | `/api/orders/:id/recompute-eligibility` | policy recompute, not forced true |

All commands require an idempotency key and optional optimistic version. Return `409` on version/state conflict.

### Order detail response shape

```json
{
  "order": { "id": "...", "number": "#D1004", "releaseStatus": "released" },
  "lines": [],
  "fulfillment": { "status": "exception", "lines": [] },
  "shipments": [],
  "invoiceEligibility": {
    "eligible": false,
    "scope": "none",
    "reasons": [{ "code": "UNRESOLVED_SHORT_SHIPMENT", "blocking": true }]
  },
  "exceptions": [],
  "timeline": [],
  "links": { "correlationId": "..." }
}
```

---

## 20. Operator UI

### Overview

- orders by handoff stage;
- exceptions by severity and age;
- oldest pending outbox message;
- reconciliation drift by system pair;
- invoice-ready vs blocked counts;
- integration health.

### Order list

Columns:

- order number;
- commerce state;
- WMS state;
- shipment state;
- invoice eligibility;
- blocking exception count;
- last update.

Filters:

- stage;
- exception severity/type;
- eligibility;
- age;
- order/SKU/tracking reference.

### Order detail

- four-handoff progress visualization;
- quantity table: ordered, cancelled, picked, packed, shipped, short, open;
- system-of-record badge per field group;
- event/audit timeline;
- shipments/tracking;
- invoice eligibility reasons;
- linked exceptions and allowed actions.

### Exception queue

- severity, age, type, system, order, assignee;
- evidence side panel;
- named resolution form;
- related messages/attempts;
- audit history.

### Reconciliation view

- run windows and status;
- findings by category;
- auto-repaired vs manual;
- side-by-side safe values;
- recommended action.

### Simulator panel

Development/demo only:

- run happy path;
- duplicate event;
- WMS acknowledgment before order;
- short shipment;
- cancellation after release;
- carrier timeout;
- omit commerce fulfillment update;
- run reconciliation.

Clearly label it `Demo Simulator`; do not expose in production configuration.

---

## 21. Security and privacy

- [ ] Tenant context derived from authentication, not request body.
- [ ] Every repository query scoped by tenant.
- [ ] Per-source webhook/mock signatures checked over raw body.
- [ ] Replay protection using message ID/idempotency constraints.
- [ ] Body limits and runtime schema validation.
- [ ] Credentials encrypted and never returned to UI.
- [ ] Logs redact payload fields by allowlist.
- [ ] Operator commands require role and reason where appropriate.
- [ ] Audit table append-only through application roles.
- [ ] Rate limits on ingestion, retry and reconciliation routes.
- [ ] No real customer PII in fixtures.
- [ ] No payment/card data anywhere.
- [ ] Dependency and secret scanning in CI.
- [ ] Safe errors with correlation ID.
- [ ] Demo/admin simulator disabled by production flag.

The portfolio may describe “audit-ready patterns,” not regulatory compliance or certification.

---

## 22. Failure matrix

The test suite and runbook must cover:

| Failure | Expected behavior | Visible evidence |
| --- | --- | --- |
| duplicate order event | no-op after one effect | duplicate counter + timeline |
| duplicate WMS acknowledgment | no duplicate state/outbox | inbox outcome |
| out-of-order acknowledgment | parked then applied | parked duration/timeline |
| missing SKU | hold release | mapping exception |
| WMS 500 | retry outbox | attempt timeline |
| WMS 400 validation | no retry loop | dead letter + fix detail |
| carrier timeout after remote create | lookup by idempotency/reference before recreate | one mock label |
| partial shipment | preserve partial quantities | blocked/partial eligibility |
| cancellation after WMS release | compensation request | explicit cancel-requested state |
| cancellation after shipment | no impossible rollback | high exception |
| commerce fulfillment 429 | bounded retry | attempts/backoff |
| commerce update lost | reconciliation rediscovers | repaired finding |
| quantity regression | reject/quarantine | non-monotonic exception |
| worker crash after commit | outbox eventually dispatches | restart test |
| worker crash during dispatch | stable idempotency/read-before-create | one remote effect |
| DB unavailable at ingress | non-2xx; sender retries | no false acknowledgement |
| cross-tenant order ID probe | deny/not found | security test/audit |

---

## 23. Testing plan

### Unit tests

- canonical mapping and schema validation;
- quantity invariants;
- all state transitions and rejected transitions;
- release policy;
- invoice eligibility truth table;
- exception deduplication keys;
- retry classification/backoff;
- event version/upcasting where present;
- field-level redaction.

### Property-based tests

Generate valid quantity chains and assert invariants. Generate randomized event duplication/order permutations and assert:

- no negative/open quantity corruption;
- no invalid final state;
- no more than one materially identical outbox effect;
- eligibility never becomes true with a blocking invariant violation.

Use deterministic seeds and print the seed on failure.

### Database integration tests

- inbox uniqueness under concurrency;
- domain mutation + outbox atomicity;
- dispatcher claim with two workers;
- expired lock recovery;
- optimistic concurrency conflict;
- active exception uniqueness;
- cross-tenant read/write denial;
- reconciliation watermark behavior.

### Adapter contract tests

Run the shared suite against each mock adapter. If a real dev adapter is added, run non-mutating contract tests separately behind an environment flag.

### Scenario tests

Minimum named scenarios:

1. `S01_HAPPY_FULL_FULFILLMENT`
2. `S02_DUPLICATE_COMMERCE_EVENT`
3. `S03_ACK_BEFORE_ORDER`
4. `S04_MISSING_SKU_HOLDS_RELEASE`
5. `S05_SHORT_SHIPMENT_BACKORDER`
6. `S06_SHORT_SHIPMENT_CLOSE_SHORT`
7. `S07_CANCEL_BEFORE_RELEASE`
8. `S08_CANCEL_AFTER_WMS_ACK`
9. `S09_CANCEL_AFTER_SHIPMENT`
10. `S10_CARRIER_TIMEOUT_AFTER_CREATE`
11. `S11_COMMERCE_FULFILLMENT_THROTTLED`
12. `S12_MISSED_UPDATE_RECONCILED`
13. `S13_TRACKING_CONFLICT`
14. `S14_WORKER_CRASH_RECOVERY`
15. `S15_CROSS_TENANT_ATTACK`

Each scenario fixture declares initial state, ordered inputs, injected failures, expected state, expected exceptions, expected outbox effects and audit assertions.

### End-to-end browser tests

- run happy scenario and inspect completed order;
- run short-shipment scenario, resolve it and inspect eligibility decision;
- run lost-update scenario and reconcile;
- attempt invalid resolution and observe safe conflict;
- switch seeded tenant context only through authorized demo control and verify isolation.

---

## 24. Observability

### Required identifiers

- `tenantId`
- `messageId`
- `idempotencyKey`
- `correlationId`
- `causationId`
- `orderId`
- `processInstanceId`
- `outboxId`
- `exceptionId`
- `reconciliationRunId`

### Metrics

- inbound messages by system/status;
- inbox processing latency;
- parked message count/oldest age;
- outbox count/oldest age/retries/dead letters;
- process state counts;
- exceptions by type/severity/age;
- adapter latency/error class;
- reconciliation findings/repairs;
- billing eligibility/block reasons;
- invalid transition attempts.

### SLO examples, labeled illustrative

- 99% of valid mock inbound events processed within 60 seconds under demo load.
- no pending outbox message older than 5 minutes in healthy demo mode.
- zero undetected seeded drift after a completed reconciliation run.

These are demonstration objectives, not client commitments.

---

## 25. Local environment

### Services

- `api`
- `worker`
- `web`
- `simulator`
- `postgres`
- `redis`
- optional `otel-collector`/metrics dashboard only if it does not delay MVP

### Commands

```text
make dev
make seed
make test
make test-scenarios
make test-e2e
make verify-invariants
make demo-happy
make demo-short-ship
make demo-reset
```

Reset must validate an explicit demo/test database name before deletion.

### Configuration

```dotenv
APP_ENV=development
DATABASE_URL=postgresql://app:app@postgres:5432/handoff_control_tower
REDIS_URL=redis://redis:6379
ADAPTER_MODE=mock
MOCK_COMMERCE_WEBHOOK_SECRET=change-me-for-local
MOCK_WMS_WEBHOOK_SECRET=change-me-for-local
MOCK_CARRIER_WEBHOOK_SECRET=change-me-for-local
OUTBOX_MAX_ATTEMPTS=5
PARKED_EVENT_MAX_AGE_MINUTES=30
RECONCILIATION_INTERVAL_MINUTES=15
ALLOW_PARTIAL_INVOICE_ELIGIBILITY=false
ENABLE_DEMO_SIMULATOR=true
```

Startup must refuse `ENABLE_DEMO_SIMULATOR=true` when `APP_ENV=production`.

---

## 26. Milestone backlog

### M0 — Repo audit and ADRs — 3-4 hours

Tasks:

- inspect repository and user changes;
- choose NestJS vs framework-light service and ORM;
- create ADR-001 stack, ADR-002 transaction/outbox, ADR-003 system-of-record;
- create status file and commands;
- validate current Node LTS and dependency compatibility.

Acceptance:

- domain package boundary is agreed;
- no existing work is overwritten;
- install/lint/test shell succeeds.

### M1 — Local platform and schema — 7-9 hours

Tasks:

- Docker Compose Postgres/Redis;
- configuration validation;
- migrations for tenants, connections, inbox, core aggregates, outbox, exceptions, reconciliation and audit;
- two tenant seeds;
- repository/transaction helpers;
- liveness/readiness.

Acceptance:

- schema builds from zero;
- tenant isolation integration tests pass;
- safe reset works only on demo/test DB.

### M2 — Domain models and policies — 7-9 hours

Tasks:

- canonical types and runtime schemas;
- quantity value objects/invariants;
- order release and fulfillment state machines;
- invoice eligibility policy/truth table;
- domain errors and events;
- framework-free unit tests.

Acceptance:

- domain imports no infrastructure;
- invalid transitions/quantities cannot commit;
- policy suite covers required combinations.

### M3 — Inbox ingestion and idempotency — 6-8 hours

Tasks:

- signed mock endpoints;
- normalized event envelope;
- raw-body verification and limits;
- inbox persistence/claim/attempt flow;
- duplicate/stale behavior;
- parking prerequisites.

Acceptance:

- concurrent duplicate tests yield one effect;
- invalid signatures/payloads produce no domain mutation;
- out-of-order fixture parks visibly.

### M4 — Transactional outbox and dispatcher — 6-8 hours

Tasks:

- outbox creation inside domain transaction;
- multi-worker claim using database locking;
- dispatch retry/backoff/jitter;
- dead-letter and manual retry guard;
- crash-after-commit and crash-during-dispatch tests.

Acceptance:

- no state commit without required outbox row;
- restart drains pending rows;
- duplicate dispatcher attempts create one mock remote effect.

### M5 — Mock adapters and contract suite — 7-9 hours

Tasks:

- implement commerce, WMS, carrier and billing mocks;
- deterministic state and pagination;
- idempotency/reference lookup;
- programmable failures and delays;
- shared adapter contract tests;
- simulator control API.

Acceptance:

- mocks behave as external processes, not direct DB shortcuts;
- all contract tests pass;
- simulator can reproduce failures by scenario seed.

### M6 — Fulfillment process manager — 8-10 hours

Tasks:

- order acceptance/release;
- WMS create/ack;
- pick/pack/short updates;
- label/shipment;
- commerce fulfillment sync/read-back;
- cancellation compensation;
- parked-message wake-up;
- audit/correlation propagation.

Acceptance:

- happy and partial paths complete;
- cancellation paths never erase evidence;
- older/out-of-order messages cannot corrupt state.

### M7 — Exception and resolution commands — 6-8 hours

Tasks:

- exception taxonomy/severity/dedup;
- assignment/notes;
- SKU mapping, short shipment and retry resolution commands;
- optimistic concurrency/idempotency;
- resolution audit.

Acceptance:

- no generic bypass resolution;
- simultaneous resolution produces one winner/one conflict;
- recomputation follows resolution deterministically.

### M8 — Reconciliation — 7-9 hours

Tasks:

- four reconciliation pairs;
- window/watermark/locking;
- finding categorization;
- conservative auto-repair;
- drift fixtures;
- manual bounded run API.

Acceptance:

- every seeded drift is detected;
- only approved categories auto-repair;
- repeat run is idempotent.

### M9 — Operator API and UI — 10-13 hours

Tasks:

- query/command routes;
- overview, order list/detail;
- exception queue/detail/actions;
- reconciliation views;
- simulator panel restricted to demo;
- loading/empty/error/stale states;
- Playwright critical journeys.

Acceptance:

- full business story is visible without DB access;
- errors show safe reason/evidence;
- cross-tenant API/UI tests pass.

### M10 — Security, observability and runbook — 5-7 hours

Tasks:

- log allowlist/redaction;
- credential encryption interface;
- role checks and command rate limits;
- structured metrics;
- failure runbook;
- secret/dependency scans.

Acceptance:

- security checklist evidence complete;
- identifiers link event → command → outbox → remote receipt;
- no fixture contains real PII.

### M11 — Scenario campaign and portfolio release — 8-10 hours

Tasks:

- implement all 15 named scenarios;
- property-based sequence tests;
- run twice from reset state;
- capture results and environment;
- README, diagrams, case study;
- screenshots/video;
- fresh-clone rehearsal and release tag.

Acceptance:

- every invariant and scenario passes;
- public metrics are reproducible and labeled synthetic;
- no MVP TODO/FIXME remains.

---

## 27. CI gate

Run on every pull request:

1. frozen dependency install;
2. format/lint/typecheck;
3. domain unit tests;
4. property-based tests with fixed CI seed set;
5. PostgreSQL/Redis integration tests;
6. migration-from-zero test;
7. shared adapter contract tests;
8. named scenario subset;
9. critical browser test;
10. secret/dependency scan;
11. Docker builds;
12. architecture dependency check preventing domain → infrastructure import.

Suggested coverage:

- domain/policies/state machines: 95% branch;
- inbox/outbox/reconciliation: 90% branch;
- overall: 80% line.

---

## 28. Demo script

### 150-second story

1. Show an order entering commerce and moving to WMS.
2. Show correlation across inbox, process and outbox without dwelling on code.
3. Duplicate the order event; show no duplicate WMS order.
4. Run the two-line short-shipment scenario.
5. Show ordered vs picked/packed/shipped/short quantities.
6. Show `Invoice blocked` and the exact reason.
7. Resolve as `close short` with an operator reason.
8. Show guarded recomputation and partial/full outcome based on seeded policy.
9. Omit commerce fulfillment confirmation, run reconciliation, and show repair.
10. Close with the system-of-record map and failure matrix.

### Screenshots

1. Four-handoff overview.
2. Order quantity/state detail.
3. Short-shipment exception evidence.
4. Outbox retry timeline.
5. Reconciliation drift/repair.
6. Invoice eligibility reasons.
7. Architecture/system-of-record diagram.

### Portfolio headline statement

> The difficult part was not calling four APIs. It was preserving ownership, quantities and intent when messages duplicated, arrived late, or contradicted one another.

---

## 29. Case-study template

Create `docs/portfolio/CASE_STUDY.md`:

1. Problem: handoffs, not lack of software.
2. Flow: commerce → WMS → carrier → billing gate.
3. System-of-record decisions.
4. Canonical data and field mapping.
5. Inbox/outbox and idempotency.
6. Partial shipment and cancellation handling.
7. Exception operations.
8. Reconciliation.
9. Synthetic scenario results.
10. Production adaptations for a named real WMS, presented conditionally.
11. Disclosure of mocks/synthetic data.

### Before/after representation

Use a `manual/fragile baseline` comparison, not a fake client case:

| Failure | Fragile integration | Control Tower demonstration |
| --- | --- | --- |
| duplicate order | may create duplicate remote order | stable inbox/outbox idempotency |
| partial shipment | binary shipped flag | per-line actual quantities |
| cancellation | overwrites/rolls back state | explicit compensation path |
| disagreement | found by support ticket | scheduled reconciliation |
| billing | status-only trigger | evidence-based eligibility gate |
| recovery | developer reads logs | operator exception workflow |

---

## 30. Definition of done

- [ ] All M0-M11 acceptance criteria pass.
- [ ] Mock-only startup needs no paid account.
- [ ] All four adapters use shared contracts.
- [ ] Domain is infrastructure-independent.
- [ ] Inbox/outbox atomicity and concurrency tests pass.
- [ ] Duplicate and out-of-order scenarios pass.
- [ ] Partial quantities remain correct through resolution.
- [ ] Cancellation compensation paths preserve evidence.
- [ ] Invoice eligibility truth table has no false-positive fixture.
- [ ] Seeded drift is detected/repaired according to policy.
- [ ] Cross-tenant tests pass.
- [ ] All operator actions are named, guarded and audited.
- [ ] README, system-of-record map, field map, event catalog and runbook exist.
- [ ] Demo media and reproducible synthetic results exist.
- [ ] Portfolio wording states mock/vendor limitations.

---

## 31. Coding-agent kickoff prompt

```text
Implement the Handoff Control Tower defined in PLAN.md. Begin with M0 and M1 only.

Before editing:
1. Inspect the repository, git status and current tooling.
2. Identify any conflict with the target structure.
3. Propose ADR-001 (framework/ORM), ADR-002 (transactional inbox/outbox) and ADR-003 (system-of-record ownership).

Non-negotiable rules:
- Preserve all user changes.
- Keep domain code independent from frameworks and vendors.
- Keep all external systems behind adapters with deterministic mocks.
- Never invent a proprietary WMS API or claim a mock is a real vendor.
- Persist inbound messages before processing.
- Commit state and outbound messages in one database transaction.
- Do not hold DB transactions during remote I/O.
- Use at-least-once delivery with idempotent effects; do not claim exactly once.
- Do not create accounting invoices; emit only guarded eligibility events.
- Use synthetic data only.
- Run each milestone's acceptance checks and update docs/IMPLEMENTATION_STATUS.md.

After M1, report the file tree, migration list, commands, tests and unresolved risks before continuing.
```

---

## 32. Reference boundaries

If an optional Shopify adapter is implemented, verify current official documentation before coding:

- Shopify webhooks: https://shopify.dev/docs/apps/build/webhooks
- Webhook verification/queueing/reconciliation: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- FulfillmentOrder: https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrder
- Fulfillment-order query: https://shopify.dev/docs/api/admin-graphql/latest/queries/fulfillmentOrders
- API limits: https://shopify.dev/docs/api/usage/limits

For any later real WMS, carrier or accounting adapter, add a vendor-specific ADR containing official API documentation, sandbox constraints, auth model, rate limits, webhook/event behavior, idempotency support, field ownership and unresolved gaps before implementation.
