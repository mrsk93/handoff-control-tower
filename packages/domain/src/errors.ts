export type DomainErrorCode =
  "SCHEMA_INVALID" | "INVALID_QUANTITY" | "INVARIANT_VIOLATION" | "INVALID_TRANSITION";

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
