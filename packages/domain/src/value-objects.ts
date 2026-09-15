import { InvariantViolationError } from "./errors";
import type { Money, Quantity, UnitOfMeasure } from "./types";

const quantityPattern = /^(0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Normalizes a SKU for exact matching. NFKC handles equivalent Unicode forms,
 * surrounding whitespace is removed, internal whitespace is made stable, and
 * case is folded. This is normalization, never fuzzy matching.
 */
export function normalizeSku(value: string, path = "sku"): string {
  if (typeof value !== "string") {
    throw new InvariantViolationError(`${path} must be a string`, path);
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
  if (normalized.length === 0) {
    throw new InvariantViolationError(`${path} must be a non-empty SKU`, path);
  }
  return normalized;
}

function quantityText(value: string | number, path: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
      throw new InvariantViolationError(`${path} must be a non-negative safe integer`, path);
    }
    return String(value);
  }
  const text = value.trim();
  if (!quantityPattern.test(text)) {
    throw new InvariantViolationError(`${path} must be an exact non-negative decimal string`, path);
  }
  return text;
}

export function exactQuantity(
  value: string | number,
  unit: UnitOfMeasure = "EA",
  path = "quantity",
): Quantity {
  if (unit === "UNKNOWN") {
    throw new InvariantViolationError(
      `${path}.unit must identify a supported unit`,
      `${path}.unit`,
    );
  }
  const text = quantityText(value, path);
  if (unit === "EA" && !/^\d+$/.test(text)) {
    throw new InvariantViolationError(`${path} must be an integer when unit is EA`, path);
  }
  return { value: text, unit };
}

export function quantityAsInteger(quantity: Quantity, path = "quantity"): number {
  if (quantity.unit !== "EA" || !/^\d+$/.test(quantity.value)) {
    throw new InvariantViolationError(`${path} must be an integer EA quantity`, path);
  }
  const parsed = Number(quantity.value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvariantViolationError(`${path} exceeds the safe integer range`, path);
  }
  return parsed;
}

export type SerializedMoney = {
  amountMinor: string;
  currency: string;
};

function currencyCode(value: string, path: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new InvariantViolationError(`${path} must be a three-letter currency code`, path);
  }
  return normalized;
}

export function money(
  amountMinor: bigint | number | string,
  currency: string,
  path = "money",
): Money {
  let amount: bigint;
  try {
    if (typeof amountMinor === "number") {
      if (!Number.isSafeInteger(amountMinor)) {
        throw new Error("unsafe integer");
      }
      amount = BigInt(amountMinor);
    } else {
      amount = BigInt(amountMinor);
    }
  } catch {
    throw new InvariantViolationError(
      `${path}.amountMinor must be an integer`,
      `${path}.amountMinor`,
    );
  }
  return { amountMinor: amount, currency: currencyCode(currency, `${path}.currency`) };
}

export function serializeMoney(value: Money): SerializedMoney {
  return {
    amountMinor: value.amountMinor.toString(),
    currency: currencyCode(value.currency, "money.currency"),
  };
}

export function parseMoney(value: unknown, path = "money"): Money {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvariantViolationError(`${path} must be an object`, path);
  }
  const candidate = value as { amountMinor?: unknown; currency?: unknown };
  if (typeof candidate.amountMinor !== "string" && typeof candidate.amountMinor !== "bigint") {
    throw new InvariantViolationError(
      `${path}.amountMinor must be a string integer`,
      `${path}.amountMinor`,
    );
  }
  if (typeof candidate.currency !== "string") {
    throw new InvariantViolationError(`${path}.currency must be a string`, `${path}.currency`);
  }
  return money(candidate.amountMinor, candidate.currency, path);
}
