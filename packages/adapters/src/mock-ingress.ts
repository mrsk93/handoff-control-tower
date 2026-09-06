import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  normalizeIntegrationEvent,
  type IntegrationEvent,
  type IntegrationEventContext,
} from "@handoff/domain";

export type MockIngressSource = "commerce" | "wms" | "carrier";

export const mockSourceSystems: Record<MockIngressSource, string> = {
  commerce: "mock-commerce",
  wms: "mock-wms",
  carrier: "mock-carrier",
};

export function parseMockIngressSource(value: string): MockIngressSource | null {
  if (value === "commerce" || value === "wms" || value === "carrier") return value;
  return null;
}

export function sha256Hex(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function createMockSignature(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyMockSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const supplied = signatureHeader.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(supplied, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseMockIngressEvent(
  rawBody: Buffer,
  source: MockIngressSource,
  context: Omit<IntegrationEventContext, "sourceSystem">,
): IntegrationEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw new Error("inbound body must be valid JSON");
  }
  return normalizeIntegrationEvent(parsed, {
    ...context,
    sourceSystem: mockSourceSystems[source],
  });
}
