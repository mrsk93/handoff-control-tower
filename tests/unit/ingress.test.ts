import { describe, expect, it } from "vitest";
import { createMockSignature, parseMockIngressEvent, verifyMockSignature } from "@handoff/adapters";
import { normalizeIntegrationEvent } from "@handoff/domain";

const tenantId = "11111111-1111-4111-8111-111111111111";
const secret = "local-commerce-secret";

function rawEvent(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      messageId: "msg-1001",
      eventType: "order.created.v1",
      eventVersion: 1,
      sourceEntityId: "COM-1001",
      sourceVersion: "1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "corr-1001",
      idempotencyKey: "commerce:msg-1001",
      payload: { orderSourceId: "COM-1001" },
      ...overrides,
    }),
  );
}

describe("mock ingress adapter", () => {
  it("verifies signatures over the exact raw body", () => {
    const body = rawEvent();
    const signature = createMockSignature(body, secret);
    expect(verifyMockSignature(body, signature, secret)).toBe(true);
    expect(verifyMockSignature(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
    expect(verifyMockSignature(body, signature, "another-secret-value")).toBe(false);
  });

  it("normalizes source metadata and derives stable defaults", () => {
    const event = parseMockIngressEvent(
      rawEvent({ correlationId: undefined, idempotencyKey: undefined }),
      "commerce",
      { tenantId, receivedAt: "2026-01-01T00:01:00.000Z" },
    );
    expect(event).toMatchObject({
      messageId: "msg-1001",
      tenantId,
      sourceSystem: "mock-commerce",
      correlationId: "mock-commerce:msg-1001",
      idempotencyKey: "mock-commerce:msg-1001",
    });
  });

  it("rejects a body tenant that disagrees with trusted context", () => {
    expect(() =>
      normalizeIntegrationEvent(
        JSON.parse(rawEvent({ tenantId: "22222222-2222-4222-8222-222222222222" }).toString()),
        { tenantId, sourceSystem: "mock-commerce", receivedAt: "2026-01-01T00:01:00.000Z" },
      ),
    ).toThrow("authenticated tenant context");
  });
});
