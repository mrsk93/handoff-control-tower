export * from "./errors";
export * from "./events";
export * from "./external-ports";
export * from "./fulfillment-process";
export * from "./integration-events";
export * from "./invoice-eligibility";
export * from "./outbox";
export * from "./quantities";
export * from "./schemas";
export * from "./state-machines";
export * from "./types";

export type TenantId = string;

export type DomainClock = {
  now(): string;
};
