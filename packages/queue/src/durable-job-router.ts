import type {
  DurableJobType,
  OutboundDelivery,
  OutboundDeliveryAdapter,
  OutboundDeliveryReceipt,
} from "@handoff/domain";

export type DurableJobHandler = (
  delivery: OutboundDelivery,
) => Promise<void | OutboundDeliveryReceipt>;

function inferJobType(messageType: string): DurableJobType | null {
  const prefix = messageType.split(".")[0];
  if (
    prefix === "catalog" ||
    prefix === "order" ||
    prefix === "fulfillment" ||
    prefix === "reconciliation"
  ) {
    return prefix;
  }
  return null;
}

export function createDurableJobRouter(
  handlers: Partial<Record<DurableJobType, DurableJobHandler>>,
): OutboundDeliveryAdapter {
  return {
    async deliver(delivery) {
      const jobType = delivery.jobType ?? inferJobType(delivery.messageType);
      if (!jobType)
        throw new Error(`outbox message has no durable job route: ${delivery.messageType}`);
      const handler = handlers[jobType];
      if (!handler) throw new Error(`durable job route is not configured: ${jobType}`);
      return handler(delivery);
    },
  };
}
