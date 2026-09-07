# Handoff Control Tower — synthetic case study

> A portfolio demonstration of preserving ownership, quantities, and intent when handoff messages
> duplicate, arrive late, fail remotely, or contradict one another.

## 1. Problem

The difficult part of a commerce-to-fulfillment flow is not calling four APIs. It is making a
durable decision when a duplicate order, a partial shipment, a cancellation, or a missed update
crosses system seams. A manual/fragile baseline tends to collapse evidence into a status flag,
making recovery and billing decisions hard to explain.

## 2. Flow

The Control Tower coordinates this flow:

`commerce order → warehouse fulfillment actual → carrier shipment evidence → guarded billing readiness`

Inbound messages enter the inbox before processing. Canonical state, audit evidence, and outbound
messages commit together. A worker claims and dispatches outbound messages after commit; remote I/O
never occurs inside a database transaction.

## 3. System-of-record decisions

| Record                                           | Owner         | Control Tower role                             |
| ------------------------------------------------ | ------------- | ---------------------------------------------- |
| accepted order identity and immutable lines      | Commerce      | preserve canonical order                       |
| allocated/picked/packed/short/shipped quantities | WMS           | preserve fulfillment actual                    |
| label, tracking, and shipment evidence           | Carrier       | preserve shipment evidence                     |
| eligibility decision                             | Control Tower | derive guarded readiness                       |
| accounting invoice                               | Billing       | outside this repository; no invoice is created |

The complete ownership map is [`ARCHITECTURE.svg`](./ARCHITECTURE.svg) and the text policy is
[`docs/SYSTEM_OF_RECORD.md`](../SYSTEM_OF_RECORD.md).

## 4. Canonical data and field mapping

Commerce `sourceOrderId` and immutable line IDs identify the canonical order. WMS quantities are
stored per canonical line. Carrier tracking is attached to shipment evidence. Billing receives an
eligibility event containing the decision version, scope, reasons, and evidence references. Values
from different owners are never silently merged.

## 5. Inbox/outbox and idempotency

The inbox records the raw normalized message and stable idempotency key before processing. The
transactional outbox records outbound intent with the same correlation and causation identifiers
as the state change. Delivery is at-least-once: a worker crash can cause a replay, so adapters
receive stable idempotency keys and the synthetic mocks deduplicate materially identical effects.
This is not an exactly-once transport claim.

## 6. Partial shipment and cancellation handling

Quantities remain per line through packed, shipped, short, and damaged evidence. `backorder` may
permit partial eligibility under configured policy; `close_short` requires an operator reason and
preserves the original short evidence. Cancellation before release cancels without a warehouse
command. Cancellation after release emits compensation and records the result. Cancellation after
shipment becomes an explicit conflict rather than an impossible rollback.

## 7. Exception operations

Exceptions are named, tenant-scoped, versioned, and evidence-backed. Operators use named commands
such as SKU mapping, short-shipment resolution, authoritative tracking acceptance, or dead-letter
retry. Each command has an idempotency key, optimistic version, actor, reason where required, and
audit event. There is no generic bypass resolution.

## 8. Reconciliation

Bounded reconciliation compares commerce orders, WMS fulfillment actuals, carrier shipments, and
commerce fulfillment read-back. Missing local authoritative records and missing commerce
reflections can be repaired through the existing inbox/outbox seams. Quantity, identity, and
tracking disagreements remain manual findings with both source values retained.

## 9. Synthetic scenario results

The campaign executes 15 named scenarios twice from fresh in-memory reset state using seed
`20260907`. Both runs pass. The detailed summary, environment, and reproducibility command are in
[`SCENARIO_RESULTS.md`](./SCENARIO_RESULTS.md). All identifiers, quantities, adapter responses,
screenshots, and metrics are synthetic.

## 10. Conditional production adaptation

If a future deployment selects a named real WMS, carrier, commerce, or billing system, that work
must begin with a vendor-specific ADR based on official documentation, authorized credentials,
rate limits, webhook behavior, idempotency support, field ownership, sandbox constraints, and
unresolved gaps. This repository deliberately implements no real vendor connector and does not
claim that a synthetic adapter is a WMS.

## Before/after representation

| Failure          | Manual/fragile baseline           | Control Tower demonstration     |
| ---------------- | --------------------------------- | ------------------------------- |
| duplicate order  | may create duplicate remote order | stable inbox/outbox idempotency |
| partial shipment | binary shipped flag               | per-line actual quantities      |
| cancellation     | overwrites or rolls back state    | explicit compensation path      |
| disagreement     | found by support ticket           | scheduled reconciliation        |
| billing          | status-only trigger               | evidence-based eligibility gate |
| recovery         | developer reads logs              | operator exception workflow     |

## Disclosure

This is a synthetic engineering demonstration. The four external-system adapters are deterministic
mocks, the carrier URLs are reserved `.invalid` examples, and no customer PII, payment data,
accounting invoice, or proprietary vendor API is included.
