import { and, eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "./client";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import { connections, externalReferences } from "./schema";

const safeConnectionSelection = {
  id: connections.id,
  tenantId: connections.tenantId,
  systemType: connections.systemType,
  environment: connections.environment,
  adapterKey: connections.adapterKey,
  status: connections.status,
  config: connections.config,
  lastVerifiedAt: connections.lastVerifiedAt,
  createdAt: connections.createdAt,
  updatedAt: connections.updatedAt,
};

export type SafeConnection = Omit<typeof connections.$inferSelect, "encryptedCredentials">;
export type ServerConnection = typeof connections.$inferSelect;
export type ConnectionSystemType = (typeof connections.systemType.enumValues)[number];
export type ConnectionEnvironment = (typeof connections.environment.enumValues)[number];
export type ConnectionStatus = (typeof connections.status.enumValues)[number];

export class ConnectionScopeError extends Error {
  readonly code = "CONNECTION_SCOPE_INVALID";

  constructor(message = "connection is not owned by the tenant") {
    super(message);
    this.name = "ConnectionScopeError";
  }
}

export class ExternalReferenceConflictError extends Error {
  readonly code = "EXTERNAL_REFERENCE_CONFLICT";

  constructor(
    readonly existing: Pick<
      typeof externalReferences.$inferSelect,
      | "id"
      | "connectionId"
      | "systemType"
      | "resourceType"
      | "externalId"
      | "canonicalType"
      | "canonicalId"
    >,
  ) {
    super("external reference is already bound to a different canonical identity");
    this.name = "ExternalReferenceConflictError";
  }
}

export class RepositoryVersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";

  constructor(resource: string, id: string) {
    super(`${resource} changed before update: ${id}`);
    this.name = "RepositoryVersionConflictError";
  }
}

export type ExternalReferenceBinding = {
  connectionId: string;
  systemType: string;
  resourceType: string;
  externalId: string;
  canonicalType: string;
  canonicalId: string;
  metadata?: Record<string, unknown>;
};

export type ExternalReferenceRecord = typeof externalReferences.$inferSelect;

export type ConnectionUpdate = {
  adapterKey?: string;
  status?: ConnectionStatus;
  config?: Record<string, unknown>;
  lastVerifiedAt?: Date | null;
};

export type ExternalReferenceMetadataUpdate = {
  metadata: Record<string, unknown>;
};

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} is required`);
  return trimmed;
}

function sameBinding(existing: ExternalReferenceRecord, input: ExternalReferenceBinding): boolean {
  return (
    existing.connectionId === input.connectionId &&
    existing.systemType === input.systemType &&
    existing.resourceType === input.resourceType &&
    existing.externalId === input.externalId &&
    existing.canonicalType === input.canonicalType &&
    existing.canonicalId === input.canonicalId
  );
}

export function createConnectionRepository(db: Database) {
  async function getServerConnection(
    context: TenantContext,
    connectionId: string,
  ): Promise<ServerConnection | null> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, scoped.tenantId), eq(connections.id, connectionId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getSafeConnection(
    context: TenantContext,
    connectionId: string,
  ): Promise<SafeConnection | null> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select(safeConnectionSelection)
      .from(connections)
      .where(and(eq(connections.tenantId, scoped.tenantId), eq(connections.id, connectionId)))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    /** Adapter-only lookup. Callers must never pass this result to operator responses. */
    getServerConnection,
    getSafeConnection,

    async listSafeConnections(context: TenantContext): Promise<SafeConnection[]> {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select(safeConnectionSelection)
        .from(connections)
        .where(eq(connections.tenantId, scoped.tenantId));
    },

    async findBySystemAndEnvironment(
      context: TenantContext,
      systemType: ConnectionSystemType,
      environment: ConnectionEnvironment,
    ): Promise<SafeConnection | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select(safeConnectionSelection)
        .from(connections)
        .where(
          and(
            eq(connections.tenantId, scoped.tenantId),
            eq(connections.systemType, systemType),
            eq(connections.environment, environment),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateConnection(
      context: TenantContext,
      connectionId: string,
      expectedUpdatedAt: Date,
      update: ConnectionUpdate,
    ): Promise<SafeConnection | null> {
      const scoped = requireTenantContext(context.tenantId);
      const existing = await getServerConnection(scoped, connectionId);
      if (!existing) return null;
      const updated = await db
        .update(connections)
        .set({
          ...(update.adapterKey === undefined
            ? {}
            : { adapterKey: required(update.adapterKey, "adapterKey") }),
          ...(update.status === undefined ? {} : { status: update.status }),
          ...(update.config === undefined ? {} : { config: update.config }),
          ...(update.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: update.lastVerifiedAt }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(connections.tenantId, scoped.tenantId),
            eq(connections.id, connectionId),
            eq(connections.updatedAt, expectedUpdatedAt),
          ),
        )
        .returning({ id: connections.id });
      if (!updated[0]) throw new RepositoryVersionConflictError("connection", connectionId);
      return getSafeConnection(scoped, connectionId);
    },

    async findExternalReference(
      context: TenantContext,
      lookup: Pick<ExternalReferenceBinding, "systemType" | "resourceType" | "externalId">,
    ): Promise<ExternalReferenceRecord | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select()
        .from(externalReferences)
        .where(
          and(
            eq(externalReferences.tenantId, scoped.tenantId),
            eq(externalReferences.systemType, required(lookup.systemType, "systemType")),
            eq(externalReferences.resourceType, required(lookup.resourceType, "resourceType")),
            eq(externalReferences.externalId, required(lookup.externalId, "externalId")),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findExternalReferenceByCanonical(
      context: TenantContext,
      lookup: Pick<
        ExternalReferenceBinding,
        "connectionId" | "systemType" | "resourceType" | "canonicalType" | "canonicalId"
      >,
    ): Promise<ExternalReferenceRecord | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select()
        .from(externalReferences)
        .where(
          and(
            eq(externalReferences.tenantId, scoped.tenantId),
            eq(externalReferences.connectionId, required(lookup.connectionId, "connectionId")),
            eq(externalReferences.systemType, required(lookup.systemType, "systemType")),
            eq(externalReferences.resourceType, required(lookup.resourceType, "resourceType")),
            eq(externalReferences.canonicalType, required(lookup.canonicalType, "canonicalType")),
            eq(externalReferences.canonicalId, required(lookup.canonicalId, "canonicalId")),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async bindExternalReference(
      context: TenantContext,
      input: ExternalReferenceBinding,
      now = new Date(),
    ): Promise<{ created: boolean; reference: ExternalReferenceRecord }> {
      const scoped = requireTenantContext(context.tenantId);
      const normalized: ExternalReferenceBinding = {
        connectionId: required(input.connectionId, "connectionId"),
        systemType: required(input.systemType, "systemType"),
        resourceType: required(input.resourceType, "resourceType"),
        externalId: required(input.externalId, "externalId"),
        canonicalType: required(input.canonicalType, "canonicalType"),
        canonicalId: required(input.canonicalId, "canonicalId"),
        metadata: input.metadata ?? {},
      };
      return db.transaction(async (transaction) => {
        const connectionRows = await transaction
          .select({ id: connections.id, systemType: connections.systemType })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, scoped.tenantId),
              eq(connections.id, normalized.connectionId),
            ),
          )
          .limit(1);
        if (!connectionRows[0]) throw new ConnectionScopeError();
        if (connectionRows[0].systemType !== normalized.systemType) {
          throw new ConnectionScopeError("connection system does not match external reference");
        }

        const inserted = await transaction
          .insert(externalReferences)
          .values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            connectionId: normalized.connectionId,
            systemType: normalized.systemType,
            resourceType: normalized.resourceType,
            externalId: normalized.externalId,
            canonicalType: normalized.canonicalType,
            canonicalId: normalized.canonicalId,
            metadata: normalized.metadata,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) return { created: true, reference: inserted[0] };

        const existingRows = await transaction
          .select()
          .from(externalReferences)
          .where(
            and(
              eq(externalReferences.tenantId, scoped.tenantId),
              or(
                and(
                  eq(externalReferences.systemType, normalized.systemType),
                  eq(externalReferences.resourceType, normalized.resourceType),
                  eq(externalReferences.externalId, normalized.externalId),
                ),
                and(
                  eq(externalReferences.connectionId, normalized.connectionId),
                  eq(externalReferences.systemType, normalized.systemType),
                  eq(externalReferences.resourceType, normalized.resourceType),
                  eq(externalReferences.canonicalType, normalized.canonicalType),
                  eq(externalReferences.canonicalId, normalized.canonicalId),
                ),
              ),
            ),
          )
          .limit(2);
        const existing = existingRows.find((row) => sameBinding(row, normalized));
        if (existing) return { created: false, reference: existing };
        throw new ExternalReferenceConflictError(
          existingRows[0] ?? {
            id: "unknown",
            connectionId: normalized.connectionId,
            systemType: normalized.systemType,
            resourceType: normalized.resourceType,
            externalId: normalized.externalId,
            canonicalType: normalized.canonicalType,
            canonicalId: normalized.canonicalId,
          },
        );
      });
    },

    async updateExternalReferenceMetadata(
      context: TenantContext,
      referenceId: string,
      expectedUpdatedAt: Date,
      update: ExternalReferenceMetadataUpdate,
      now = new Date(),
    ): Promise<ExternalReferenceRecord | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .update(externalReferences)
        .set({ metadata: update.metadata, updatedAt: now })
        .where(
          and(
            eq(externalReferences.tenantId, scoped.tenantId),
            eq(externalReferences.id, referenceId),
            eq(externalReferences.updatedAt, expectedUpdatedAt),
          ),
        )
        .returning();
      if (rows[0]) return rows[0];
      const existing = await db
        .select({ id: externalReferences.id })
        .from(externalReferences)
        .where(
          and(
            eq(externalReferences.tenantId, scoped.tenantId),
            eq(externalReferences.id, referenceId),
          ),
        )
        .limit(1);
      if (existing[0]) throw new RepositoryVersionConflictError("external reference", referenceId);
      return null;
    },
  };
}
