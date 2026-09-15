# System-of-record ownership

This table is the implementation contract for mutations and reconciliation.

| Data/state                                 | Authoritative source        | Local role                               | Allowed outbound target                 |
| ------------------------------------------ | --------------------------- | ---------------------------------------- | --------------------------------------- |
| Order identity and accepted lines          | Shopify / commerce          | Immutable canonical snapshot + revisions | ERPNext and ShipBob                     |
| Release/fraud/payment flag                 | Shopify / commerce          | Release policy input                     | ShipBob hold/release request            |
| Warehouse acknowledgment                   | ShipBob / warehouse         | Process state                            | Operator display and Shopify read model |
| Allocated/picked/packed/shipped quantities | ShipBob / warehouse         | Fulfillment actuals                      | ERPNext, Shopify and billing gate       |
| Short/over/damaged quantity                | ShipBob / warehouse         | Exception evidence                       | Operator and billing gate               |
| Label and tracking                         | ShipBob or carrier evidence | Shipment evidence                        | ERPNext and Shopify                     |
| Commerce fulfillment record                | Shopify / commerce          | Remote confirmation/read-back            | Reconciliation                          |
| ERPNext Customer/Item/Sales Order          | ERPNext                     | External reference and workflow evidence | None beyond mapped workflows            |
| ERPNext Delivery Note and stock evidence   | ERPNext                     | Accounting/ERP corroborating evidence    | Operator and reconciliation             |
| Inventory execution/location balance       | ShipBob                     | Snapshot, mismatch detection, no repair  | Operator-approved repair only           |
| Invoice eligibility                        | Control Tower policy        | Derived state/event                      | Billing-event sink                      |
| Accounting invoice                         | External accounting system  | Out of scope                             | None                                    |

Mock systems remain synthetic adapters and do not represent or emulate a proprietary
WMS/API contract. Live provider adapters must preserve these ownership boundaries,
keep vendor DTOs inside the adapter, and use tenant-scoped external references.
