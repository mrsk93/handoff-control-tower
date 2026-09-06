import {
  boolean,
  check,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);
export const connectionSystemType = pgEnum("connection_system_type", [
  "commerce",
  "wms",
  "carrier",
  "billing",
]);
export const connectionStatus = pgEnum("connection_status", [
  "active",
  "disabled",
  "error",
  "reauth_required",
]);
export const inboxStatus = pgEnum("inbox_status", [
  "received",
  "processing",
  "processed",
  "parked",
  "dead_letter",
  "ignored",
]);
export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "dispatching",
  "sent",
  "retry_wait",
  "dead_letter",
  "cancelled",
]);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: tenantStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("tenants_slug_uq").on(table.slug)],
);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    systemType: connectionSystemType("system_type").notNull(),
    adapterKey: text("adapter_key").notNull(),
    status: connectionStatus("status").notNull().default("active"),
    encryptedCredentials: bytea("encrypted_credentials"),
    config: jsonb("config").notNull().default({}),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("connections_tenant_system_uq").on(table.tenantId, table.systemType),
    index("connections_tenant_idx").on(table.tenantId),
  ],
);

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceSystem: text("source_system").notNull(),
    messageId: text("message_id").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    sourceEntityId: text("source_entity_id").notNull(),
    sourceVersion: text("source_version"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    status: inboxStatus("status").notNull().default("received"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    prerequisiteType: text("prerequisite_type"),
    prerequisiteKey: text("prerequisite_key"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("inbox_source_message_uq").on(table.tenantId, table.sourceSystem, table.messageId),
    uniqueIndex("inbox_idempotency_uq").on(table.tenantId, table.idempotencyKey),
    index("inbox_claim_idx").on(table.status, table.availableAt),
    index("inbox_tenant_idx").on(table.tenantId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    source: text("source").notNull(),
    sourceOrderId: text("source_order_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    orderNumber: text("order_number").notNull(),
    currency: text("currency").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    releaseStatus: text("release_status").notNull(),
    canonicalHash: text("canonical_hash").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("orders_tenant_source_id_uq").on(table.tenantId, table.sourceOrderId),
    index("orders_tenant_idx").on(table.tenantId),
    check(
      "orders_release_status_ck",
      sql`${table.releaseStatus} in ('pending', 'released', 'held', 'cancelled')`,
    ),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    sourceLineId: text("source_line_id").notNull(),
    sku: text("sku").notNull(),
    orderedQty: integer("ordered_qty").notNull(),
    cancelledQty: integer("cancelled_qty").notNull().default(0),
  },
  (table) => [
    uniqueIndex("order_lines_order_source_id_uq").on(table.orderId, table.sourceLineId),
    index("order_lines_tenant_idx").on(table.tenantId),
    check(
      "order_lines_nonnegative_ck",
      sql`${table.orderedQty} >= 0 and ${table.cancelledQty} >= 0`,
    ),
    check("order_lines_cancelled_le_ordered_ck", sql`${table.cancelledQty} <= ${table.orderedQty}`),
  ],
);

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    warehouseOrderId: text("warehouse_order_id"),
    status: text("status").notNull(),
    sourceVersion: text("source_version"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("fulfillments_order_uq").on(table.tenantId, table.orderId),
    index("fulfillments_tenant_idx").on(table.tenantId),
  ],
);

export const fulfillmentLines = pgTable(
  "fulfillment_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fulfillmentId: uuid("fulfillment_id")
      .notNull()
      .references(() => fulfillments.id),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id),
    allocatedQty: integer("allocated_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    packedQty: integer("packed_qty").notNull().default(0),
    shippedQty: integer("shipped_qty").notNull().default(0),
    shortQty: integer("short_qty").notNull().default(0),
    damagedQty: integer("damaged_qty").notNull().default(0),
  },
  (table) => [
    uniqueIndex("fulfillment_lines_line_uq").on(table.fulfillmentId, table.orderLineId),
    index("fulfillment_lines_tenant_idx").on(table.tenantId),
    check(
      "fulfillment_lines_nonnegative_ck",
      sql`
    ${table.allocatedQty} >= 0 and ${table.pickedQty} >= 0 and ${table.packedQty} >= 0 and
    ${table.shippedQty} >= 0 and ${table.shortQty} >= 0 and ${table.damagedQty} >= 0
  `,
    ),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    sourceShipmentId: text("source_shipment_id"),
    externalShipmentId: text("external_shipment_id"),
    carrierCode: text("carrier_code").notNull(),
    serviceCode: text("service_code").notNull(),
    trackingNumber: text("tracking_number").notNull(),
    trackingUrl: text("tracking_url"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("shipments_tenant_source_id_uq").on(table.tenantId, table.sourceShipmentId),
    uniqueIndex("shipments_tenant_tracking_uq").on(
      table.tenantId,
      table.trackingNumber,
      table.carrierCode,
    ),
    index("shipments_tenant_idx").on(table.tenantId),
  ],
);

export const shipmentLines = pgTable(
  "shipment_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id),
    orderLineId: uuid("order_line_id")
      .notNull()
      .references(() => orderLines.id),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    uniqueIndex("shipment_lines_line_uq").on(table.shipmentId, table.orderLineId),
    index("shipment_lines_tenant_idx").on(table.tenantId),
    check("shipment_lines_quantity_ck", sql`${table.quantity} >= 0`),
  ],
);

export const processInstances = pgTable(
  "process_instances",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    currentStep: text("current_step").notNull(),
    lastAppliedEventVersion: text("last_applied_event_version"),
    blockingExceptionCount: integer("blocking_exception_count").notNull().default(0),
    invoiceEligible: boolean("invoice_eligible").notNull().default(false),
    decisionVersion: integer("decision_version").notNull().default(0),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("process_instances_order_uq").on(table.tenantId, table.orderId),
    index("process_instances_tenant_idx").on(table.tenantId),
  ],
);

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    destination: text("destination").notNull(),
    messageType: text("message_type").notNull(),
    messageVersion: integer("message_version").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    status: outboxStatus("status").notNull().default("pending"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("outbox_destination_idempotency_uq").on(
      table.tenantId,
      table.destination,
      table.idempotencyKey,
    ),
    index("outbox_claim_idx").on(table.status, table.availableAt),
    index("outbox_tenant_idx").on(table.tenantId),
  ],
);

export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id").references(() => orders.id),
    processInstanceId: uuid("process_instance_id").references(() => processInstances.id),
    orderLineId: uuid("order_line_id").references(() => orderLines.id),
    shipmentId: uuid("shipment_id").references(() => shipments.id),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    activeKey: text("active_key"),
    machineSummary: text("machine_summary").notNull(),
    operatorDetails: text("operator_details"),
    evidence: jsonb("evidence").notNull().default({}),
    assignee: text("assignee"),
    resolutionCode: text("resolution_code"),
    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("exceptions_tenant_status_idx").on(table.tenantId, table.status),
    index("exceptions_order_idx").on(table.tenantId, table.orderId),
  ],
);

export const exceptionCommands = pgTable(
  "exception_commands",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    exceptionId: uuid("exception_id")
      .notNull()
      .references(() => exceptions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result").notNull().default({}),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("exception_commands_tenant_idempotency_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("exception_commands_exception_idx").on(table.tenantId, table.exceptionId),
  ],
);

export const exceptionNotes = pgTable(
  "exception_notes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    exceptionId: uuid("exception_id")
      .notNull()
      .references(() => exceptions.id),
    authorId: text("author_id").notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("exception_notes_exception_idx").on(table.tenantId, table.exceptionId, table.createdAt),
  ],
);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    systemPair: text("system_pair").notNull(),
    resourceType: text("resource_type").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    pageCursor: text("page_cursor"),
    counts: jsonb("counts").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("reconciliation_runs_tenant_idx").on(table.tenantId)],
);

export const reconciliationFindings = pgTable(
  "reconciliation_findings",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => reconciliationRuns.id),
    category: text("category").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceKey: text("resource_key").notNull(),
    sourceValues: jsonb("source_values").notNull().default({}),
    recommendedAction: text("recommended_action"),
    repairStatus: text("repair_status").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("reconciliation_findings_run_resource_uq").on(
      table.runId,
      table.resourceType,
      table.resourceKey,
      table.category,
    ),
    index("reconciliation_findings_tenant_idx").on(table.tenantId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    beforeSummary: jsonb("before_summary"),
    afterSummary: jsonb("after_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_events_entity_idx").on(table.tenantId, table.entityType, table.entityId),
  ],
);

export const schema = {
  tenants,
  connections,
  inboxMessages,
  orders,
  orderLines,
  fulfillments,
  fulfillmentLines,
  shipments,
  shipmentLines,
  processInstances,
  outboxMessages,
  exceptions,
  exceptionCommands,
  exceptionNotes,
  reconciliationRuns,
  reconciliationFindings,
  auditEvents,
};
