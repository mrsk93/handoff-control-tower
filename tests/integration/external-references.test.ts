import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createConnectionRepository,
  createTenantRepository,
  DEMO_TENANTS,
  type DatabaseHandle,
} from "@handoff/db";
import {
  ConnectionScopeError,
  ExternalReferenceConflictError,
  RepositoryVersionConflictError,
} from "@handoff/db";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const northstarCommerce = "31111111-1111-4111-8111-111111111111";
const bluebirdCommerce = "32222222-2222-4222-8222-222222222221";
const createdAt = new Date("2026-01-01T01:00:00.000Z");

describe.skipIf(!testDatabaseUrl)("connection and external-reference repositories", () => {
  let handle: DatabaseHandle | undefined;
  let repository: ReturnType<typeof createConnectionRepository>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    if (!handle) throw new Error("test database was not opened");
    repository = createConnectionRepository(handle.db);
    await handle.pool.query(
      `update connections set encrypted_credentials = decode('deadbeef', 'hex')
       where id = $1`,
      [northstarCommerce],
    );
  });

  afterAll(async () => closeTestDatabase(handle));

  it("returns safe connection metadata by default and keeps credentials server-only", async () => {
    if (!handle) throw new Error("test database was not opened");
    const safe = await repository.getSafeConnection(
      { tenantId: DEMO_TENANTS.northstar },
      northstarCommerce,
    );
    expect(safe).toMatchObject({
      id: northstarCommerce,
      tenantId: DEMO_TENANTS.northstar,
      systemType: "commerce",
      environment: "mock",
    });
    expect(safe).not.toHaveProperty("encryptedCredentials");

    const server = await repository.getServerConnection(
      { tenantId: DEMO_TENANTS.northstar },
      northstarCommerce,
    );
    expect(server?.encryptedCredentials).toEqual(Buffer.from("deadbeef", "hex"));
    expect(
      await repository.getSafeConnection({ tenantId: DEMO_TENANTS.bluebird }, northstarCommerce),
    ).toBeNull();

    const operatorConnections = await createTenantRepository(handle.db).listConnections({
      tenantId: DEMO_TENANTS.northstar,
    });
    expect(operatorConnections.every((connection) => !("encryptedCredentials" in connection))).toBe(
      true,
    );
    expect(
      await repository.findBySystemAndEnvironment(
        { tenantId: DEMO_TENANTS.northstar },
        "commerce",
        "mock",
      ),
    ).toMatchObject({ id: northstarCommerce });
  });

  it("updates connections only when the expected version still matches", async () => {
    const before = await repository.getSafeConnection(
      { tenantId: DEMO_TENANTS.northstar },
      northstarCommerce,
    );
    if (!before) throw new Error("seed connection was not found");
    const updated = await repository.updateConnection(
      { tenantId: DEMO_TENANTS.northstar },
      northstarCommerce,
      before.updatedAt,
      { config: { fixture: "updated" } },
    );
    expect(updated?.config).toEqual({ fixture: "updated" });
    if (!updated) throw new Error("connection update did not return a row");
    await expect(
      repository.updateConnection(
        { tenantId: DEMO_TENANTS.northstar },
        northstarCommerce,
        before.updatedAt,
        { status: "disabled" },
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("converges concurrent identical binds and rejects reassignment", async () => {
    const input = {
      connectionId: northstarCommerce,
      systemType: "commerce",
      resourceType: "order",
      externalId: "gid://shopify/Order/T016-1001",
      canonicalType: "order",
      canonicalId: "41111111-1111-4111-8111-111111111111",
      metadata: { source: "test" },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.bindExternalReference({ tenantId: DEMO_TENANTS.northstar }, input, createdAt),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.reference.externalId === input.externalId)).toBe(true);
    expect(
      await repository.findExternalReference({ tenantId: DEMO_TENANTS.northstar }, input),
    ).toMatchObject({ canonicalId: input.canonicalId });

    await expect(
      repository.bindExternalReference(
        { tenantId: DEMO_TENANTS.northstar },
        {
          ...input,
          canonicalId: "42222222-2222-4222-8222-222222222222",
        },
      ),
    ).rejects.toBeInstanceOf(ExternalReferenceConflictError);
    await expect(
      repository.bindExternalReference(
        { tenantId: DEMO_TENANTS.northstar },
        {
          ...input,
          externalId: "gid://shopify/Order/T016-1002",
        },
      ),
    ).rejects.toBeInstanceOf(ExternalReferenceConflictError);
  });

  it("allows the same provider ID in another tenant but blocks foreign connections", async () => {
    const input = {
      connectionId: bluebirdCommerce,
      systemType: "commerce",
      resourceType: "order",
      externalId: "gid://shopify/Order/T016-1001",
      canonicalType: "order",
      canonicalId: "42222222-2222-4222-8222-222222222222",
    };
    const result = await repository.bindExternalReference(
      { tenantId: DEMO_TENANTS.bluebird },
      input,
      createdAt,
    );
    expect(result.created).toBe(true);
    expect(
      await repository.findExternalReference({ tenantId: DEMO_TENANTS.northstar }, input),
    ).toMatchObject({ canonicalId: "41111111-1111-4111-8111-111111111111" });
    await expect(
      repository.bindExternalReference(
        { tenantId: DEMO_TENANTS.northstar },
        { ...input, canonicalId: "43333333-3333-4333-8333-333333333333" },
      ),
    ).rejects.toBeInstanceOf(ConnectionScopeError);
  });

  it("updates only reference metadata with optimistic concurrency", async () => {
    const result = await repository.bindExternalReference(
      { tenantId: DEMO_TENANTS.northstar },
      {
        connectionId: northstarCommerce,
        systemType: "commerce",
        resourceType: "product",
        externalId: "gid://shopify/Product/T016-1001",
        canonicalType: "catalog_item",
        canonicalId: "51111111-1111-4111-8111-111111111111",
      },
      createdAt,
    );
    const next = new Date("2026-01-01T01:01:00.000Z");
    const updated = await repository.updateExternalReferenceMetadata(
      { tenantId: DEMO_TENANTS.northstar },
      result.reference.id,
      result.reference.updatedAt,
      { metadata: { verified: true } },
      next,
    );
    expect(updated?.metadata).toEqual({ verified: true });
    await expect(
      repository.updateExternalReferenceMetadata(
        { tenantId: DEMO_TENANTS.northstar },
        result.reference.id,
        result.reference.updatedAt,
        { metadata: { verified: false } },
      ),
    ).rejects.toBeInstanceOf(RepositoryVersionConflictError);
  });
});
