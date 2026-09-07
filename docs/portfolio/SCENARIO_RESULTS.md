# Scenario campaign evidence

This report is reproducible synthetic evidence for the Handoff Control Tower portfolio release.
It is not customer, vendor, production, or regulatory evidence.

## Run envelope

| Field               | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| command             | `pnpm test:scenarios:twice`                                        |
| seed                | `20260907`                                                         |
| reset mode          | fresh in-memory scenario state before each campaign run            |
| runs                | 2                                                                  |
| scenarios per run   | 15                                                                 |
| scenario executions | 30                                                                 |
| delivery language   | at-least-once; stable idempotency keys                             |
| data                | synthetic identifiers, quantities, failures, and adapter responses |
| Node                | `v22.21.1`                                                         |
| pnpm                | `10.33.0`                                                          |
| PostgreSQL / Redis  | not required for this pure scenario campaign                       |
| Docker              | unavailable on the capture host                                    |

## Results

Both runs passed all fixture assertions and produced identical summaries.

| Scenario                             | Expected evidence                                     | Remote effects |
| ------------------------------------ | ----------------------------------------------------- | -------------: |
| `S01_HAPPY_FULL_FULFILLMENT`         | full-order readiness; four outbox intents             |              3 |
| `S02_DUPLICATE_COMMERCE_EVENT`       | two duplicate inbox outcomes; one warehouse intent    |              0 |
| `S03_ACK_BEFORE_ORDER`               | parked then woken warehouse acknowledgment            |              0 |
| `S04_MISSING_SKU_HOLDS_RELEASE`      | `MISSING_SKU_MAPPING`; release held                   |              0 |
| `S05_SHORT_SHIPMENT_BACKORDER`       | partial readiness; short quantity preserved           |              0 |
| `S06_SHORT_SHIPMENT_CLOSE_SHORT`     | full-order readiness after named close-short decision |              0 |
| `S07_CANCEL_BEFORE_RELEASE`          | cancellation without warehouse command                |              0 |
| `S08_CANCEL_AFTER_WMS_ACK`           | cancellation compensation and confirmed cancellation  |              0 |
| `S09_CANCEL_AFTER_SHIPMENT`          | `CANCEL_AFTER_SHIPMENT`; evidence preserved           |              0 |
| `S10_CARRIER_TIMEOUT_AFTER_CREATE`   | read-before-recreate; one carrier effect              |              1 |
| `S11_COMMERCE_FULFILLMENT_THROTTLED` | bounded retry; readiness eventually reflected         |              0 |
| `S12_MISSED_UPDATE_RECONCILED`       | `missing_remote`; commerce repair outbox intent       |              0 |
| `S13_TRACKING_CONFLICT`              | `tracking_mismatch`; manual evidence retained         |              0 |
| `S14_WORKER_CRASH_RECOVERY`          | replay after crash; one warehouse effect              |              1 |
| `S15_CROSS_TENANT_ATTACK`            | `CROSS_TENANT_ACCESS_DENIED`; no state mutation       |              0 |

## Reproduce

```text
pnpm install --frozen-lockfile
pnpm test:properties
pnpm test:scenarios
pnpm test:scenarios:twice
SCENARIO_SEED=20260907 pnpm release:evidence
```

The command prints JSON with `synthetic: true`, the seed, both reset runs, every scenario ID,
exception/finding summaries, outbox effects, and remote-effect counts. A changed seed is accepted
only when the same fixture contract remains green; a campaign failure prints the seed and failing
scenario evidence.

## Interpretation

The remote-effect counts demonstrate deterministic mock idempotency, not exactly-once delivery.
`billing.eligibility` is a readiness event only. No accounting invoice is created, and no real
commerce, WMS, carrier, or billing system is connected.
