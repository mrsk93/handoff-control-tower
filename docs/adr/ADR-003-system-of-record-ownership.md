# ADR-003: Explicit system-of-record ownership

## Status

Accepted for M0/M1 and all later milestones.

## Decision

Ownership is assigned by field and state, not by whichever system reported most recently:

| Field or state                                   | Authoritative source       | Control Tower role                         |
| ------------------------------------------------ | -------------------------- | ------------------------------------------ |
| Accepted order identity and lines                | Commerce                   | Immutable canonical snapshot and revisions |
| Release/fraud/payment signal                     | Commerce                   | Release-policy input                       |
| Warehouse acknowledgment and fulfillment actuals | Warehouse                  | Canonical operational actuals and evidence |
| Label and tracking reference                     | Carrier                    | Shipment evidence                          |
| Commerce fulfillment record                      | Commerce                   | Remote confirmation/read-back              |
| Invoice eligibility                              | Control Tower              | Derived guarded decision and event         |
| Accounting invoice                               | External accounting system | Out of scope; never created here           |

When more than one system can confirm shipment, configuration must identify one authoritative source and treat the other as corroborating evidence. Timestamps are never silently merged. Conflicts become explicit exceptions with evidence and audit history.

## Consequences

- Canonical data is a normalized snapshot, not a replacement for external ownership.
- Reconciliation can identify drift without guessing which value should win.
- Partial shipments and cancellation compensation preserve actual evidence.
- Billing readiness cannot be inferred from a status flag alone.
