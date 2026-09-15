import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockSignature } from "@handoff/adapters";
import { DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { createInboxIngestionService } from "@handoff/queue";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const now = new Date("2026-01-01T00:10:00.000Z");
const secret = "local-wms-secret";

function eventBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      messageId: "wms-msg-1001",
      eventType: "wms.order.acknowledged.v1",
      eventVersion: 1,
      sourceEntityId: "COM-MISSING-1001",
      sourceVersion: "1",
      occurredAt: "2026-01-01T00:09:00.000Z",
      idempotencyKey: "wms:ack:1001",
      payload: { orderSourceId: "COM-MISSING-1001" },
      ...overrides,
    }),
  );
}

describe.skipIf(!testDatabaseUrl)("inbox ingestion", () => {
  let handle: DatabaseHandle | undefined;
  let service: ReturnType<typeof createInboxIngestionService>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    service = createInboxIngestionService({
      config: {
        ingestMaxBodyBytes: 1_048_576,
        mockWebhookSecrets: {
          commerce: "local-commerce-secret",
          wms: secret,
          carrier: "local-carrier-secret",
        },
      },
      db: handle.db,
      clock: () => now,
    });
  });

  afterAll(async () => closeTestDatabase(handle));

  it("concurrent duplicates create one durable inbox effect", async () => {
    if (!handle) throw new Error("test database was not opened");
    const body = eventBody({
      messageId: "duplicate-message-1",
      idempotencyKey: "duplicate-key-1",
      sourceEntityId: "COM-DEMO-1001",
      payload: { orderSourceId: "COM-DEMO-1001" },
    });
    const signature = createMockSignature(body, secret);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.accept({
          source: "wms",
          tenantId: DEMO_TENANTS.northstar,
          rawBody: body,
          signatureHeader: signature,
          now,
        }),
      ),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    const accepted = results.find((result) => !result.duplicate);
    if (!accepted) throw new Error("one duplicate submission should be accepted");
    const count = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from inbox_messages
       where tenant_id = $1 and idempotency_key = $2`,
      [DEMO_TENANTS.northstar, "duplicate-key-1"],
    );
    expect(count.rows[0]?.count).toBe("1");
    const metadata = await handle.pool.query<{ signature_verified: boolean; observed_at: Date }>(
      `select signature_verified, observed_at from inbox_messages where id = $1`,
      [accepted.inboxId],
    );
    expect(metadata.rows[0]).toMatchObject({ signature_verified: true, observed_at: now });
    const claim = await service.repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "duplicate-test-worker",
      now,
    );
    expect(claim?.id).toBe(accepted.inboxId);
    await service.repository.recordOutcome(
      { tenantId: DEMO_TENANTS.northstar },
      accepted.inboxId,
      "duplicate-test-worker",
      { status: "processed" },
    );
  });

  it("rejects invalid signatures and payloads without inserting inbox rows", async () => {
    if (!handle) throw new Error("test database was not opened");
    const before = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from inbox_messages",
    );
    const body = eventBody({ messageId: "invalid-message-1", idempotencyKey: "invalid-key-1" });
    await expect(
      service.accept({
        source: "wms",
        tenantId: DEMO_TENANTS.northstar,
        rawBody: body,
        signatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        now,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    const invalidBody = Buffer.from(JSON.stringify({ messageId: "invalid-payload-1" }));
    await expect(
      service.accept({
        source: "wms",
        tenantId: DEMO_TENANTS.northstar,
        rawBody: invalidBody,
        signatureHeader: createMockSignature(invalidBody, secret),
        now,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    const after = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from inbox_messages",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("rejects a reused delivery id with a different payload and records the conflict", async () => {
    if (!handle) throw new Error("test database was not opened");
    const original = eventBody({
      messageId: "conflict-message-1",
      idempotencyKey: "conflict-key-1",
      sourceEntityId: "COM-DEMO-1001",
      payload: { orderSourceId: "COM-DEMO-1001", quantity: 1 },
    });
    await service.accept({
      source: "wms",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: original,
      signatureHeader: createMockSignature(original, secret),
      now,
    });

    const altered = eventBody({
      messageId: "conflict-message-1",
      idempotencyKey: "conflict-key-1",
      sourceEntityId: "COM-DEMO-1001",
      payload: { orderSourceId: "COM-DEMO-1001", quantity: 2 },
    });
    await expect(
      service.accept({
        source: "wms",
        tenantId: DEMO_TENANTS.northstar,
        rawBody: altered,
        signatureHeader: createMockSignature(altered, secret),
        now,
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_CONFLICT" });

    const row = await service.repository.findByDelivery(
      { tenantId: DEMO_TENANTS.northstar },
      "mock-wms",
      "conflict-message-1",
    );
    expect(row).toMatchObject({
      errorCode: "INBOX_PAYLOAD_CONFLICT",
      lastError: "delivery payload hash conflict",
    });
    const claim = await service.repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "conflict-test-worker",
      now,
    );
    expect(claim?.id).toBe(row?.id);
    await service.repository.recordOutcome(
      { tenantId: DEMO_TENANTS.northstar },
      row?.id ?? "",
      "conflict-test-worker",
      { status: "processed" },
    );
  });

  it("persists verified connection metadata and redacted event evidence", async () => {
    const body = eventBody({
      messageId: "verified-message-1",
      idempotencyKey: "verified-key-1",
      source: undefined,
      eventType: "commerce.order.created.v1",
      sourceEntityId: "COM-DEMO-1001",
      payload: { orderSourceId: "COM-DEMO-1001", email: "person@example.invalid" },
    });
    const verifiedAt = new Date("2026-01-01T00:11:00.000Z");
    const result = await service.accept({
      source: "commerce",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: body,
      now,
      verified: {
        connectionId: "31111111-1111-4111-8111-111111111111",
        sourceApiVersion: "2026-01",
        signatureVerified: true,
        signatureVerifiedAt: verifiedAt,
      },
    });
    expect(result.status).toBe("received");

    const row = await service.repository.findByDelivery(
      { tenantId: DEMO_TENANTS.northstar },
      "mock-commerce",
      "verified-message-1",
    );
    expect(row).toMatchObject({
      id: result.inboxId,
      connectionId: "31111111-1111-4111-8111-111111111111",
      sourceApiVersion: "2026-01",
      signatureVerified: true,
      signatureVerifiedAt: verifiedAt,
      payload: { orderSourceId: "COM-DEMO-1001", email: "[REDACTED]" },
    });
    expect(
      await service.repository.listEvents(
        { tenantId: DEMO_TENANTS.northstar },
        { sourceSystem: "mock-commerce", status: "received", limit: 10 },
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.inboxId })]));
    expect(
      await service.repository.findByDelivery(
        { tenantId: DEMO_TENANTS.bluebird },
        "mock-commerce",
        "verified-message-1",
      ),
    ).toBeNull();
    const claim = await service.repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "verified-test-worker",
      now,
    );
    expect(claim?.id).toBe(result.inboxId);
    await service.repository.recordOutcome(
      { tenantId: DEMO_TENANTS.northstar },
      result.inboxId,
      "verified-test-worker",
      { status: "processed" },
    );
  });

  it("parks an out-of-order WMS event with a visible prerequisite", async () => {
    const body = eventBody({ messageId: "parked-message-1", idempotencyKey: "parked-key-1" });
    const result = await service.accept({
      source: "wms",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: body,
      signatureHeader: createMockSignature(body, secret),
      now,
    });
    expect(result.status).toBe("parked");
    const parked = await service.repository.listParked({ tenantId: DEMO_TENANTS.northstar });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      messageId: "parked-message-1",
      prerequisiteType: "order",
      prerequisiteKey: "COM-MISSING-1001",
      status: "parked",
    });
    expect(
      await service.repository.claimNext({ tenantId: DEMO_TENANTS.northstar }, "worker-1", now),
    ).toBeNull();
  });

  it("claims and completes a received message without holding a remote operation", async () => {
    const body = eventBody({
      messageId: "received-message-1",
      idempotencyKey: "received-key-1",
      sourceEntityId: "COM-DEMO-1001",
      payload: { orderSourceId: "COM-DEMO-1001" },
    });
    const result = await service.accept({
      source: "wms",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: body,
      signatureHeader: createMockSignature(body, secret),
      now,
    });
    expect(result.status).toBe("received");
    const claim = await service.repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "worker-1",
      now,
    );
    expect(claim).toMatchObject({
      messageId: "received-message-1",
      status: "processing",
      attemptCount: 1,
    });
    expect(
      await service.repository.recordOutcome(
        { tenantId: DEMO_TENANTS.northstar },
        result.inboxId,
        "worker-1",
        { status: "processed" },
      ),
    ).toMatchObject({ status: "processed", lockedBy: null });
  });

  it("marks an older source version ignored after a newer version is stored", async () => {
    const newer = eventBody({
      messageId: "version-message-2",
      idempotencyKey: "version-key-2",
      sourceEntityId: "COM-DEMO-1001",
      sourceVersion: "2",
      payload: { orderSourceId: "COM-DEMO-1001" },
    });
    await service.accept({
      source: "wms",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: newer,
      signatureHeader: createMockSignature(newer, secret),
      now,
    });
    const older = eventBody({
      messageId: "version-message-1",
      idempotencyKey: "version-key-1",
      sourceEntityId: "COM-DEMO-1001",
      sourceVersion: "1",
      payload: { orderSourceId: "COM-DEMO-1001" },
    });
    const result = await service.accept({
      source: "wms",
      tenantId: DEMO_TENANTS.northstar,
      rawBody: older,
      signatureHeader: createMockSignature(older, secret),
      now,
    });
    expect(result).toMatchObject({ status: "ignored", stale: true, duplicate: false });
  });
});
