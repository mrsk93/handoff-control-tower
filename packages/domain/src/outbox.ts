export type OutboundMessage = {
  tenantId: string;
  destination: string;
  messageType: string;
  messageVersion: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  availableAt?: string;
};

export type OutboundDelivery = OutboundMessage & {
  id: string;
  attemptCount: number;
};

export type OutboundDeliveryReceipt = {
  remoteReceiptId: string;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  acceptedAt: string;
  duplicate: boolean;
};

export type OutboundDeliveryAdapter = {
  deliver(message: OutboundDelivery): Promise<void | OutboundDeliveryReceipt>;
};
