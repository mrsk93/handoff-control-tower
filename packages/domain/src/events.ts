import type {
  CanonicalOrder,
  FulfillmentStatus,
  InvoiceEligibilityDecision,
  OrderReleaseStatus,
} from "./types";

export type DomainEventType =
  "order.release_changed" | "fulfillment.status_changed" | "invoice.eligibility_determined";

export type DomainEvent = {
  eventId: string;
  eventType: DomainEventType;
  tenantId: string;
  aggregateType: "order" | "fulfillment";
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type OrderReleaseChangedPayload = {
  previousStatus: OrderReleaseStatus;
  currentStatus: OrderReleaseStatus;
  reason?: string;
};

export type FulfillmentStatusChangedPayload = {
  previousStatus: FulfillmentStatus;
  currentStatus: FulfillmentStatus;
  version: number;
  reason?: string;
};

export type InvoiceEligibilityDeterminedPayload = InvoiceEligibilityDecision;

export function createInvoiceEligibilityEvent(
  order: CanonicalOrder,
  decision: InvoiceEligibilityDecision,
): DomainEvent {
  return {
    eventId: decision.idempotencyKey,
    eventType: "invoice.eligibility_determined",
    tenantId: order.tenantId,
    aggregateType: "order",
    aggregateId: order.orderId,
    occurredAt: decision.computedAt,
    payload: decision,
  };
}
