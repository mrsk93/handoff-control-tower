import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@handoff/config": resolve(__dirname, "packages/config/src/index.ts"),
      "@handoff/db": resolve(__dirname, "packages/db/src/index.ts"),
      "@handoff/domain": resolve(__dirname, "packages/domain/src/index.ts"),
      "@handoff/adapters": resolve(__dirname, "packages/adapters/src/index.ts"),
      "@handoff/queue": resolve(__dirname, "packages/queue/src/index.ts"),
      "@handoff/observability": resolve(__dirname, "packages/observability/src/index.ts"),
      "@handoff/security": resolve(__dirname, "packages/security/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    fileParallelism: false,
  },
});
