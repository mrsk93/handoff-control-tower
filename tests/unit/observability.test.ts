import { describe, expect, it } from "vitest";
import { MetricsRegistry, StructuredLogger } from "@handoff/observability";

describe("observability seam", () => {
  it("emits allowlisted structured logs with the identifier chain and no payload secrets", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));

    logger.info(
      "outbox.delivery.sent",
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        messageId: "inbox-1",
        idempotencyKey: "event-1",
        correlationId: "corr-1",
        causationId: "command-1",
        orderId: "order-1",
        processInstanceId: "process-1",
        outboxId: "outbox-1",
        exceptionId: "exception-1",
        reconciliationRunId: "run-1",
        remoteReceiptId: "mock-receipt-1",
      },
      {
        destination: "mock-commerce",
        status: "sent",
        payload: { customerEmail: "not-allowed@example.com", card: "never" },
        secret: "must-not-log",
        error: "raw remote response must not log",
      },
    );

    const event = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "outbox.delivery.sent",
      correlationId: "corr-1",
      causationId: "command-1",
      outboxId: "outbox-1",
      remoteReceiptId: "mock-receipt-1",
      destination: "mock-commerce",
      status: "sent",
    });
    expect(JSON.stringify(event)).not.toContain("customerEmail");
    expect(JSON.stringify(event)).not.toContain("must-not-log");
    expect(JSON.stringify(event)).not.toContain("raw remote response");
  });

  it("records bounded counters and histograms without identifiers as labels", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("handoff_inbound_messages_total", { system: "commerce", status: "received" });
    metrics.increment("handoff_inbound_messages_total", { system: "commerce", status: "received" });
    metrics.observe("handoff_inbox_processing_seconds", 0.25, { system: "commerce" });

    expect(metrics.snapshot()).toEqual({
      counters: {
        'handoff_inbound_messages_total{status="received",system="commerce"}': 2,
      },
      histograms: {
        'handoff_inbox_processing_seconds{system="commerce"}': {
          count: 1,
          sum: 0.25,
          max: 0.25,
        },
      },
    });
    expect(metrics.renderPrometheus()).toContain(
      'handoff_inbound_messages_total{status="received",system="commerce"} 2',
    );
  });
});
