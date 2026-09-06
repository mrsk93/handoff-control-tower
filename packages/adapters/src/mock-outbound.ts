import type { OutboundDelivery, OutboundDeliveryAdapter } from "@handoff/domain";

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

  deliver(message: OutboundDelivery): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("deterministic mock delivery failure"));
    }
    const key = effectKey(message);
    if (!this.effects.has(key)) this.effects.set(key, message);
    return Promise.resolve();
  }

  effectCount(): number {
    return this.effects.size;
  }

  hasEffect(message: OutboundDelivery): boolean {
    return this.effects.has(effectKey(message));
  }
}
