import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  DEMO_TENANTS,
  inboxMessages,
  syncAttempts,
  syncOperations,
  type DatabaseHandle,
} from "@handoff/db";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const northstarCommerce = "31111111-1111-4111-8111-111111111111";
const bluebirdCommerce = "32222222-2222-4222-8222-222222222221";
const observedAt = new Date("2026-01-01T00:30:00.000Z");

describe.skipIf(!testDatabaseUrl)("event and sync-operation metadata", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("maps an integration event onto the inbox ledger with provider evidence", async () => {
    if (!handle) throw new Error("test database was not opened");
    await handle.db.insert(inboxMessages).values({
      id: "91111111-1111-4111-8111-111111111111",
      tenantId: DEMO_TENANTS.northstar,
      connectionId: northstarCommerce,
      sourceSystem: "shopify",
      messageId: "shopify-delivery-1001",
      eventType: "orders/create",
      eventVersion: 1,
      sourceEntityId: "gid://shopify/Order/1001",
      sourceVersion: "2026-01",
      occurredAt: new Date("2026-01-01T00:29:00.000Z"),
      receivedAt: observedAt,
      observedAt,
      sourceApiVersion: "2026-01",
      signatureVerified: true,
      signatureVerifiedAt: observedAt,
      correlationId: "corr-shopify-1001",
      idempotencyKey: "shopify-delivery-1001",
      payload: { orderId: "gid://shopify/Order/1001" },
      payloadSha256: "sha256-redacted-fixture",
      availableAt: observedAt,
      createdAt: observedAt,
    });

    const row = await handle.pool.query<{
      connection_id: string;
      observed_at: Date;
      signature_verified: boolean;
      source_api_version: string;
    }>(
      `select connection_id, observed_at, signature_verified, source_api_version
       from inbox_messages where id = $1`,
      ["91111111-1111-4111-8111-111111111111"],
    );
    expect(row.rows[0]).toMatchObject({
      connection_id: northstarCommerce,
      observed_at: observedAt,
      signature_verified: true,
      source_api_version: "2026-01",
    });

    await expect(
      handle.db.insert(inboxMessages).values({
        id: "92222222-2222-4222-8222-222222222222",
        tenantId: DEMO_TENANTS.northstar,
        connectionId: northstarCommerce,
        sourceSystem: "shopify",
        messageId: "shopify-delivery-1002",
        eventType: "orders/create",
        eventVersion: 1,
        sourceEntityId: "gid://shopify/Order/1002",
        occurredAt: observedAt,
        receivedAt: observedAt,
        observedAt,
        correlationId: "corr-shopify-1002",
        idempotencyKey: "shopify-delivery-1001",
        payload: { orderId: "gid://shopify/Order/1002" },
        payloadSha256: "sha256-redacted-fixture-2",
        availableAt: observedAt,
        createdAt: observedAt,
      }),
    ).rejects.toThrow();
  });

  it("keeps business-operation idempotency independent from delivery deduplication", async () => {
    if (!handle) throw new Error("test database was not opened");
    const idempotencyKey = "shared-delivery-and-operation-key";
    await handle.db.insert(inboxMessages).values({
      id: "93333333-3333-4333-8333-333333333333",
      tenantId: DEMO_TENANTS.northstar,
      connectionId: northstarCommerce,
      sourceSystem: "shopify",
      messageId: "shopify-delivery-2001",
      eventType: "orders/updated",
      eventVersion: 1,
      sourceEntityId: "gid://shopify/Order/2001",
      occurredAt: observedAt,
      receivedAt: observedAt,
      observedAt,
      correlationId: "corr-shopify-2001",
      idempotencyKey,
      payload: { orderId: "gid://shopify/Order/2001" },
      payloadSha256: "sha256-redacted-operation-fixture",
      availableAt: observedAt,
      createdAt: observedAt,
    });
    await handle.db.insert(syncOperations).values({
      id: "94444444-4444-4444-8444-444444444444",
      tenantId: DEMO_TENANTS.northstar,
      connectionId: northstarCommerce,
      workflowType: "shopify_order_hydration",
      aggregateType: "order",
      aggregateId: "order-2001",
      direction: "pull",
      idempotencyKey,
      status: "pending",
      attemptCount: 0,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    await expect(
      handle.db.insert(syncOperations).values({
        id: "95555555-5555-4555-8555-555555555555",
        tenantId: DEMO_TENANTS.northstar,
        connectionId: northstarCommerce,
        workflowType: "shopify_order_hydration",
        aggregateType: "order",
        aggregateId: "order-2001",
        direction: "pull",
        idempotencyKey,
        status: "pending",
        attemptCount: 0,
        createdAt: observedAt,
        updatedAt: observedAt,
      }),
    ).rejects.toThrow();

    await handle.db.insert(syncAttempts).values({
      id: "96666666-6666-4666-8666-666666666666",
      tenantId: DEMO_TENANTS.northstar,
      operationId: "94444444-4444-4444-8444-444444444444",
      attempt: 1,
      outcome: "retryable",
      httpMethod: "GET",
      requestPath: "/admin/api/2026-01/orders/2001.json",
      statusCode: 429,
      requestId: "shopify-request-2001",
      retryAfterMs: 1000,
      durationMs: 120,
      errorCode: "RATE_LIMITED",
      errorMessage: "provider rate limit; retry scheduled",
      startedAt: observedAt,
      completedAt: new Date(observedAt.getTime() + 120),
      createdAt: observedAt,
    });
    await expect(
      handle.db.insert(syncAttempts).values({
        id: "97777777-7777-4777-8777-777777777777",
        tenantId: DEMO_TENANTS.northstar,
        operationId: "94444444-4444-4444-8444-444444444444",
        attempt: 1,
        outcome: "retryable",
        startedAt: observedAt,
        createdAt: observedAt,
      }),
    ).rejects.toThrow();
  });

  it("enforces tenant-scoped references and append-only audit evidence", async () => {
    if (!handle) throw new Error("test database was not opened");
    await expect(
      handle.db.insert(syncOperations).values({
        id: "98888888-8888-4888-8888-888888888888",
        tenantId: DEMO_TENANTS.northstar,
        connectionId: bluebirdCommerce,
        workflowType: "cross_tenant_probe",
        aggregateType: "order",
        aggregateId: "order-cross-tenant",
        direction: "push",
        idempotencyKey: "cross-tenant-operation",
        status: "pending",
        attemptCount: 0,
        createdAt: observedAt,
        updatedAt: observedAt,
      }),
    ).rejects.toThrow();

    await handle.db.insert(auditEvents).values({
      id: "99999999-9999-4999-8999-999999999999",
      tenantId: DEMO_TENANTS.northstar,
      actorType: "system",
      action: "operation_failed",
      entityType: "sync_operation",
      entityId: "94444444-4444-4444-8444-444444444444",
      afterSummary: { errorCode: "RATE_LIMITED", requestId: "shopify-request-2001" },
      createdAt: observedAt,
    });
    await expect(
      handle.pool.query("update audit_events set action = 'tampered' where id = $1", [
        "99999999-9999-4999-8999-999999999999",
      ]),
    ).rejects.toThrow("append-only");
    await expect(
      handle.pool.query("delete from audit_events where id = $1", [
        "99999999-9999-4999-8999-999999999999",
      ]),
    ).rejects.toThrow("append-only");
  });
});
