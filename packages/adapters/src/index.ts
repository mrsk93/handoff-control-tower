/**
 * External-system adapter seam reserved for M5.
 *
 * No real vendor contract is invented in M0/M1. Future adapters must expose
 * versioned ports and deterministic mock implementations.
 */
export type AdapterMode = "mock";
export * from "./mock-billing";
export * from "./mock-carrier";
export * from "./mock-commerce";
export * from "./mock-ingress";
export * from "./mock-outbound";
export * from "./mock-runtime";
export * from "./mock-suite";
export * from "./mock-warehouse";
