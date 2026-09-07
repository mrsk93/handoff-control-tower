export type CorrelationContext = {
  tenantId: string;
  correlationId: string;
};

export type TraceIdentifiers = {
  tenantId?: string;
  messageId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  orderId?: string;
  processInstanceId?: string;
  outboxId?: string;
  exceptionId?: string;
  reconciliationRunId?: string;
  remoteReceiptId?: string;
};

export type StructuredLogSink = (line: string) => void;
export type StructuredLogFields = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error";

const identifierKeys: readonly (keyof TraceIdentifiers)[] = [
  "tenantId",
  "messageId",
  "idempotencyKey",
  "correlationId",
  "causationId",
  "orderId",
  "processInstanceId",
  "outboxId",
  "exceptionId",
  "reconciliationRunId",
  "remoteReceiptId",
];

const fieldKeys = new Set([
  "system",
  "sourceSystem",
  "destination",
  "messageType",
  "status",
  "outcome",
  "attemptCount",
  "errorClass",
  "durationMs",
  "route",
  "role",
  "permission",
  "rateLimitRule",
  "httpStatus",
  "remoteDuplicate",
  "reasonCode",
  "method",
]);

function safeFields(fields: StructuredLogFields): StructuredLogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        fieldKeys.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null),
    ),
  );
}

function safeIdentifiers(identifiers: TraceIdentifiers): TraceIdentifiers {
  return Object.fromEntries(
    identifierKeys
      .map((key) => [key, identifiers[key]] as const)
      .filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

export class StructuredLogger {
  constructor(private readonly sink: StructuredLogSink = (line) => console.log(line)) {}

  log(
    level: LogLevel,
    event: string,
    identifiers: TraceIdentifiers = {},
    fields: StructuredLogFields = {},
  ): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...safeIdentifiers(identifiers),
        ...safeFields(fields),
      }),
    );
  }

  info(event: string, identifiers: TraceIdentifiers = {}, fields: StructuredLogFields = {}): void {
    this.log("info", event, identifiers, fields);
  }

  warn(event: string, identifiers: TraceIdentifiers = {}, fields: StructuredLogFields = {}): void {
    this.log("warn", event, identifiers, fields);
  }

  error(event: string, identifiers: TraceIdentifiers = {}, fields: StructuredLogFields = {}): void {
    this.log("error", event, identifiers, fields);
  }
}

export type MetricLabels = Record<string, string | number | boolean>;
export type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; max: number }>;
};

const metricLabelKeys = new Set([
  "system",
  "sourceSystem",
  "destination",
  "messageType",
  "status",
  "errorClass",
  "severity",
  "route",
  "outcome",
  "stage",
  "category",
  "reason",
]);

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function metricKey(name: string, labels: MetricLabels): string {
  const normalized = Object.entries(labels)
    .filter(([key, value]) => metricLabelKeys.has(key) && String(value).length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (normalized.length === 0) return name;
  const rendered = normalized
    .map(([key, value]) => `${key}="${escapeLabel(String(value))}"`)
    .join(",");
  return `${name}{${rendered}}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number; max: number }>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("metric increment must be positive");
    }
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("metric observation must be non-negative");
    }
    const key = metricKey(name, labels);
    const current = this.histograms.get(key) ?? { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += value;
    current.max = Math.max(current.max, value);
    this.histograms.set(key, current);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.histograms) {
      lines.push(`${key}_count ${value.count}`);
      lines.push(`${key}_sum ${value.sum}`);
      lines.push(`${key}_max ${value.max}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
