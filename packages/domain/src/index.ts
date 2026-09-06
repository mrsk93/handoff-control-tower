export * from "./errors";
export * from "./events";
export * from "./invoice-eligibility";
export * from "./quantities";
export * from "./schemas";
export * from "./state-machines";
export * from "./types";

export type TenantId = string;

export type DomainClock = {
  now(): string;
};
