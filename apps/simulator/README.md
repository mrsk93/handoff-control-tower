# Demo simulator

The M5 simulator controls deterministic in-memory external-process mocks for development and test. It can set a scenario seed, failure rate, operation-specific failure budgets, and delays through the API routes documented in the root README.

The simulator is disabled when `ENABLE_DEMO_SIMULATOR=false` and is unavailable in production. It uses synthetic data only and never writes application tables directly.
