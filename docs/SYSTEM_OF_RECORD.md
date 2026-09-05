# System-of-record ownership

This table is the implementation contract for mutations and reconciliation.

| Data/state                                 | Authoritative source       | Local role                               | Allowed outbound target                  |
| ------------------------------------------ | -------------------------- | ---------------------------------------- | ---------------------------------------- |
| Order identity and accepted lines          | Commerce mock              | Immutable canonical snapshot + revisions | Warehouse mock                           |
| Release/fraud/payment flag                 | Commerce mock              | Release policy input                     | Warehouse hold/release request           |
| Warehouse acknowledgment                   | Warehouse mock             | Process state                            | Operator display and commerce read model |
| Allocated/picked/packed/shipped quantities | Warehouse mock             | Fulfillment actuals                      | Commerce mock and billing gate           |
| Short/over/damaged quantity                | Warehouse mock             | Exception evidence                       | Operator and billing gate                |
| Label and tracking                         | Carrier mock               | Shipment evidence                        | Warehouse and commerce mocks             |
| Commerce fulfillment record                | Commerce mock              | Remote confirmation/read-back            | Reconciliation                           |
| Invoice eligibility                        | Control Tower policy       | Derived state/event                      | Billing-event sink                       |
| Accounting invoice                         | External accounting system | Out of scope                             | None                                     |

All mock systems are synthetic adapters. They do not represent or emulate a proprietary WMS API contract.
