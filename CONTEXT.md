# Handoff Control Tower

This context coordinates accepted commerce orders with warehouse fulfillment, carrier evidence, and guarded billing-readiness signals.

## Language

**Canonical order**:
The accepted commerce-owned order identity and immutable line snapshot used by the Control Tower.
_Avoid_: invoice, warehouse order

**Fulfillment actual**:
Warehouse-owned evidence of allocated, picked, packed, short, damaged, and shipped quantities for a canonical order.
_Avoid_: fulfillment request, shipment

**Shipment**:
Carrier-owned evidence that a concrete quantity was labeled or shipped with a tracking reference.
_Avoid_: fulfillment, invoice

**Cancellation compensation**:
A new warehouse command and its resulting evidence after a released order receives a cancellation request; it never erases prior fulfillment evidence.
_Avoid_: rollback, undo

**Exception command**:
A named operator action with explicit preconditions, idempotency, optimistic concurrency, and an audit record.
_Avoid_: generic resolve, bypass

**Invoice eligibility**:
A derived Control Tower decision that may be emitted to billing as readiness evidence; it does not create an accounting invoice.
_Avoid_: invoice, billing transaction
