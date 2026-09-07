import { createHash } from "node:crypto";
import type {
  OutboundDelivery,
  OutboundDeliveryAdapter,
  OutboundDeliveryReceipt,
} from "@handoff/domain";

function effectKey(message: OutboundDelivery): string {
  return `${message.tenantId}:${message.destination}:${message.idempotencyKey}`;
}

export class DeterministicMockOutboundAdapter implements OutboundDeliveryAdapter {
  private readonly effects = new Map<string, OutboundDelivery>();
  private failuresRemaining = 0;

  failNextDeliveries(count: number): void {
    if (!Number.isInteger(count) || count < 0)
      throw new Error("failure count must be non-negative");
    this.failuresRemaining = count;
  }

  deliver(message: OutboundDelivery): Promise<OutboundDeliveryReceipt> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("deterministic mock delivery failure"));
    }
    const key = effectKey(message);
    const duplicate = this.effects.has(key);
    if (!duplicate) this.effects.set(key, message);
    const remoteReceiptId = `mock-receipt-${createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 20)}`;
    const receipt: OutboundDeliveryReceipt = {
      remoteReceiptId,
      idempotencyKey: message.idempotencyKey,
      correlationId: message.correlationId,
      ...(message.causationId === undefined ? {} : { causationId: message.causationId }),
      acceptedAt: message.availableAt ?? new Date(0).toISOString(),
      duplicate,
    };
    return Promise.resolve(receipt);
  }

  effectCount(): number {
    return this.effects.size;
  }

  hasEffect(message: OutboundDelivery): boolean {
    return this.effects.has(effectKey(message));
  }
}
