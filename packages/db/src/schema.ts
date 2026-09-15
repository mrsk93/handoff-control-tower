import {
  boolean,
  bigint,
  check,
  customType,
  foreignKey,
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
  "erp",
  "wms",
  "carrier",
  "billing",
]);
export const connectionEnvironment = pgEnum("connection_environment", [
  "mock",
  "sandbox",
  "production",
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
export const syncOperationStatus = pgEnum("sync_operation_status", [
  "pending",
  "running",
  "succeeded",
  "retrying",
  "failed",
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
    environment: connectionEnvironment("environment").notNull().default("mock"),
    adapterKey: text("adapter_key").notNull(),
    status: connectionStatus("status").notNull().default("active"),
    encryptedCredentials: bytea("encrypted_credentials"),
    config: jsonb("config").notNull().default({}),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("connections_tenant_system_environment_uq").on(
      table.tenantId,
      table.systemType,
      table.environment,
    ),
    index("connections_tenant_idx").on(table.tenantId),
  ],
);

export const externalReferences = pgTable(
  "external_references",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    systemType: text("system_type").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    canonicalType: text("canonical_type").notNull(),
    canonicalId: uuid("canonical_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("external_references_tenant_system_resource_external_uq").on(
      table.tenantId,
      table.systemType,
      table.resourceType,
      table.externalId,
    ),
    uniqueIndex("external_references_tenant_connection_canonical_uq").on(
      table.tenantId,
      table.connectionId,
      table.systemType,
      table.resourceType,
      table.canonicalType,
      table.canonicalId,
    ),
    index("external_references_tenant_idx").on(table.tenantId),
    index("external_references_connection_idx").on(table.tenantId, table.connectionId),
  ],
);

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sku: text("sku").notNull(),
    normalizedSku: text("normalized_sku").notNull(),
    name: text("name").notNull(),
    barcode: text("barcode"),
    active: boolean("active").notNull().default(true),
    requiresShipping: boolean("requires_shipping").notNull().default(true),
    unit: text("unit").notNull().default("EA"),
    weight: jsonb("weight"),
    dimensions: jsonb("dimensions"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("catalog_items_tenant_normalized_sku_uq").on(table.tenantId, table.normalizedSku),
    index("catalog_items_tenant_idx").on(table.tenantId),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text("email"),
    displayName: text("display_name").notNull(),
    phone: text("phone"),
    billingAddress: jsonb("billing_address"),
    shippingAddresses: jsonb("shipping_addresses").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("customers_tenant_idx").on(table.tenantId)],
);

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    connectionId: uuid("connection_id"),
    sourceSystem: text("source_system").notNull(),
    messageId: text("message_id").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    sourceEntityId: text("source_entity_id").notNull(),
    sourceVersion: text("source_version"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceApiVersion: text("source_api_version"),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    signatureVerifiedAt: timestamp("signature_verified_at", { withTimezone: true }),
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
    lastAppliedEventId: text("last_applied_event_id"),
    errorCode: text("error_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
      name: "inbox_messages_tenant_connection_fk",
    }),
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
    customerId: uuid("customer_id").references(() => customers.id),
    lifecycleStatus: text("lifecycle_status"),
    financialStatus: text("financial_status"),
    requestedShippingMethod: text("requested_shipping_method"),
    shippingAddress: jsonb("shipping_address"),
    billingAddress: jsonb("billing_address"),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }),
    shippingTotalMinor: bigint("shipping_total_minor", { mode: "bigint" }),
    taxTotalMinor: bigint("tax_total_minor", { mode: "bigint" }),
    discountTotalMinor: bigint("discount_total_minor", { mode: "bigint" }),
    grandTotalMinor: bigint("grand_total_minor", { mode: "bigint" }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
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
    uniqueIndex("orders_tenant_order_number_uq").on(table.tenantId, table.orderNumber),
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
    lineNumber: text("line_number"),
    skuId: uuid("sku_id").references(() => catalogItems.id),
    sku: text("sku").notNull(),
    title: text("title"),
    unit: text("unit"),
    orderedQuantity: jsonb("ordered_quantity"),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }),
    discountTotalMinor: bigint("discount_total_minor", { mode: "bigint" }),
    taxTotalMinor: bigint("tax_total_minor", { mode: "bigint" }),
    orderedQty: integer("ordered_qty").notNull(),
    cancelledQty: integer("cancelled_qty").notNull().default(0),
  },
  (table) => [
    uniqueIndex("order_lines_order_source_id_uq").on(table.orderId, table.sourceLineId),
    uniqueIndex("order_lines_order_line_number_uq").on(table.orderId, table.lineNumber),
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
    provider: text("provider").notNull().default("wms"),
    sourceVersion: text("source_version"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("fulfillments_tenant_order_provider_uq").on(
      table.tenantId,
      table.orderId,
      table.provider,
    ),
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
    fulfillmentId: uuid("fulfillment_id").references(() => fulfillments.id),
    provider: text("provider").notNull().default("wms"),
    sourceShipmentId: text("source_shipment_id"),
    externalShipmentId: text("external_shipment_id"),
    carrierCode: text("carrier_code").notNull(),
    serviceCode: text("service_code").notNull(),
    trackingNumber: text("tracking_number").notNull(),
    trackingUrl: text("tracking_url"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("shipments_tenant_source_id_uq").on(table.tenantId, table.sourceShipmentId),
    uniqueIndex("shipments_tenant_provider_external_uq").on(
      table.tenantId,
      table.provider,
      table.externalShipmentId,
    ),
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

export const syncOperations = pgTable(
  "sync_operations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    connectionId: uuid("connection_id"),
    workflowType: text("workflow_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    direction: text("direction").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandHash: text("command_hash"),
    status: syncOperationStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    result: jsonb("result"),
    remoteId: text("remote_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    leaseToken: uuid("lease_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("sync_operations_tenant_idempotency_uq").on(table.tenantId, table.idempotencyKey),
    uniqueIndex("sync_operations_tenant_id_uq").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
      name: "sync_operations_tenant_connection_fk",
    }),
    index("sync_operations_claim_idx").on(table.status, table.nextAttemptAt),
    index("sync_operations_aggregate_idx").on(
      table.tenantId,
      table.aggregateType,
      table.aggregateId,
      table.createdAt,
    ),
    index("sync_operations_tenant_idx").on(table.tenantId),
    check("sync_operations_attempt_count_ck", sql`${table.attemptCount} >= 0`),
    check(
      "sync_operations_text_fields_ck",
      sql`
      length(trim(${table.workflowType})) > 0 and
      length(trim(${table.aggregateType})) > 0 and
      length(trim(${table.aggregateId})) > 0 and
      length(trim(${table.direction})) > 0 and
      length(trim(${table.idempotencyKey})) > 0
    `,
    ),
  ],
);

export const syncAttempts = pgTable(
  "sync_attempts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    operationId: uuid("operation_id").notNull(),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(),
    httpMethod: text("http_method"),
    requestPath: text("request_path"),
    statusCode: integer("status_code"),
    requestId: text("request_id"),
    retryAfterMs: integer("retry_after_ms"),
    durationMs: integer("duration_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("sync_attempts_tenant_operation_attempt_uq").on(
      table.tenantId,
      table.operationId,
      table.attempt,
    ),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [syncOperations.tenantId, syncOperations.id],
      name: "sync_attempts_tenant_operation_fk",
    }),
    index("sync_attempts_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("sync_attempts_operation_idx").on(table.tenantId, table.operationId, table.createdAt),
    check("sync_attempts_attempt_ck", sql`${table.attempt} >= 1`),
    check(
      "sync_attempts_status_code_ck",
      sql`${table.statusCode} is null or (${table.statusCode} >= 100 and ${table.statusCode} <= 599)`,
    ),
    check(
      "sync_attempts_retry_after_ck",
      sql`${table.retryAfterMs} is null or ${table.retryAfterMs} >= 0`,
    ),
    check(
      "sync_attempts_duration_ck",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
  ],
);

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    connectionId: uuid("connection_id"),
    syncOperationId: uuid("sync_operation_id"),
    jobType: text("job_type"),
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
    workflowType: text("workflow_type"),
    aggregateType: text("aggregate_type"),
    aggregateId: text("aggregate_id"),
    providerApiVersion: text("provider_api_version"),
    lastRequestId: text("last_request_id"),
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
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
      name: "outbox_messages_tenant_connection_fk",
    }),
    foreignKey({
      columns: [table.tenantId, table.syncOperationId],
      foreignColumns: [syncOperations.tenantId, syncOperations.id],
      name: "outbox_messages_tenant_operation_fk",
    }),
    index("outbox_sync_operation_idx").on(table.tenantId, table.syncOperationId),
  ],
);

export const outboxDeliveryReceipts = pgTable(
  "outbox_delivery_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    outboxId: uuid("outbox_id")
      .notNull()
      .references(() => outboxMessages.id),
    attemptCount: integer("attempt_count").notNull(),
    remoteReceiptId: text("remote_receipt_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    duplicate: boolean("duplicate").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("outbox_delivery_receipts_attempt_uq").on(
      table.tenantId,
      table.outboxId,
      table.attemptCount,
    ),
    index("outbox_delivery_receipts_tenant_outbox_idx").on(
      table.tenantId,
      table.outboxId,
      table.createdAt,
    ),
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
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
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

export const reconciliationLeases = pgTable(
  "reconciliation_leases",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    systemPair: text("system_pair").notNull(),
    resourceType: text("resource_type").notNull(),
    lockedBy: text("locked_by").notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("reconciliation_leases_key_uq").on(
      table.tenantId,
      table.systemPair,
      table.resourceType,
    ),
    index("reconciliation_leases_expiry_idx").on(table.lockedUntil),
  ],
);

export const reconciliationWatermarks = pgTable(
  "reconciliation_watermarks",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    systemPair: text("system_pair").notNull(),
    resourceType: text("resource_type").notNull(),
    lastWindowEnd: timestamp("last_window_end", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("reconciliation_watermarks_key_uq").on(
      table.tenantId,
      table.systemPair,
      table.resourceType,
    ),
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
  syncOperations,
  syncAttempts,
  outboxMessages,
  outboxDeliveryReceipts,
  exceptions,
  exceptionCommands,
  exceptionNotes,
  reconciliationRuns,
  reconciliationFindings,
  reconciliationLeases,
  reconciliationWatermarks,
  auditEvents,
};
