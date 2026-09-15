export type DomainErrorCode =
  "SCHEMA_INVALID" | "INVALID_QUANTITY" | "INVARIANT_VIOLATION" | "INVALID_TRANSITION";

export type ConnectorErrorCategory =
  | "retryable"
  | "authentication"
  | "validation"
  | "conflict"
  | "not_found"
  | "unsupported"
  | "rate_limited"
  | "unknown";

export type ConnectorErrorMetadata = {
  requestId?: string;
  retryAfterMs?: number;
  statusCode?: number;
  operation?: string;
};

export type DomainIssue = {
  path: string;
  message: string;
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly issues: readonly DomainIssue[];

  constructor(code: DomainErrorCode, message: string, issues: readonly DomainIssue[] = []) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.issues = issues;
  }
}

export class SchemaValidationError extends DomainError {
  constructor(issues: readonly DomainIssue[]) {
    super(
      "SCHEMA_INVALID",
      `Domain schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      issues,
    );
    this.name = "SchemaValidationError";
  }
}

export class InvalidQuantityError extends DomainError {
  constructor(message: string, path = "quantity") {
    super("INVALID_QUANTITY", message, [{ path, message }]);
    this.name = "InvalidQuantityError";
  }
}

export class InvariantViolationError extends DomainError {
  constructor(message: string, path = "") {
    super("INVARIANT_VIOLATION", message, [{ path, message }]);
    this.name = "InvariantViolationError";
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(aggregate: string, currentState: string, command: string) {
    const message = `Cannot apply ${command} to ${aggregate} in state ${currentState}`;
    super("INVALID_TRANSITION", message, [{ path: aggregate, message }]);
    this.name = "InvalidTransitionError";
  }
}

export class OptimisticConcurrencyError extends Error {
  readonly code = "OPTIMISTIC_CONCURRENCY_CONFLICT";

  constructor(message = "the resource changed before this command could be applied") {
    super(message);
    this.name = "OptimisticConcurrencyError";
  }
}

export class InvalidExceptionCommandError extends Error {
  readonly code = "INVALID_EXCEPTION_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "InvalidExceptionCommandError";
  }
}

export class ConnectorError extends Error {
  readonly code: string;
  readonly category: ConnectorErrorCategory;
  readonly metadata: ConnectorErrorMetadata;

  constructor(
    code: string,
    category: ConnectorErrorCategory,
    message: string,
    metadata: ConnectorErrorMetadata = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.category = category;
    this.metadata = { ...metadata };
  }

  get retryable(): boolean {
    return this.category === "retryable" || this.category === "rate_limited";
  }
}

export class RetryableConnectorError extends ConnectorError {
  constructor(
    message: string,
    code = "CONNECTOR_RETRYABLE",
    metadata: ConnectorErrorMetadata = {},
  ) {
    super(code, "retryable", message, metadata);
    this.name = "RetryableConnectorError";
  }
}

export class PermanentConnectorError extends ConnectorError {
  constructor(
    message: string,
    code = "CONNECTOR_PERMANENT",
    metadata: ConnectorErrorMetadata = {},
    category: Exclude<
      ConnectorErrorCategory,
      "retryable" | "rate_limited" | "unknown"
    > = "validation",
  ) {
    super(code, category, message, metadata);
    this.name = "PermanentConnectorError";
  }
}

export class UnsupportedConnectorError extends ConnectorError {
  constructor(
    message = "connector capability is not supported",
    metadata: ConnectorErrorMetadata = {},
  ) {
    super("CONNECTOR_CAPABILITY_UNSUPPORTED", "unsupported", message, metadata);
    this.name = "UnsupportedConnectorError";
  }
}

export function connectorErrorFromStatus(
  statusCode: number,
  operation: string,
  metadata: Omit<ConnectorErrorMetadata, "statusCode" | "operation"> = {},
): ConnectorError {
  const shared = { ...metadata, statusCode, operation };
  if (statusCode === 401 || statusCode === 403) {
    return new ConnectorError(
      "CONNECTOR_AUTH_FAILED",
      "authentication",
      "connector authentication failed",
      shared,
    );
  }
  if (statusCode === 404) {
    return new ConnectorError(
      "CONNECTOR_NOT_FOUND",
      "not_found",
      "connector resource was not found",
      shared,
    );
  }
  if (statusCode === 409) {
    return new ConnectorError(
      "CONNECTOR_CONFLICT",
      "conflict",
      "connector reported a resource conflict",
      shared,
    );
  }
  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500) {
    return new ConnectorError(
      statusCode === 429 ? "CONNECTOR_RATE_LIMITED" : "CONNECTOR_RETRYABLE",
      statusCode === 429 ? "rate_limited" : "retryable",
      "connector request should be retried",
      shared,
    );
  }
  if (statusCode === 400 || statusCode === 422) {
    return new ConnectorError(
      "CONNECTOR_VALIDATION_FAILED",
      "validation",
      "connector rejected the request",
      shared,
    );
  }
  return new ConnectorError("CONNECTOR_UNKNOWN", "unknown", "connector request failed", shared);
}

export function classifyConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  return new ConnectorError(
    "CONNECTOR_UNKNOWN",
    "unknown",
    "connector operation failed; inspect the operation audit for details",
  );
}
