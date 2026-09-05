import { describe, expect, it } from "vitest";
import { checkReadiness } from "@handoff/config";

describe("readiness probes", () => {
  it("reports all dependencies healthy", async () => {
    const result = await checkReadiness([
      { name: "postgres", check: () => Promise.resolve() },
      { name: "redis", check: () => Promise.resolve() },
    ]);
    expect(result).toEqual({ ready: true, dependencies: { postgres: "ok", redis: "ok" } });
  });

  it("reports failed dependencies without exposing error details", async () => {
    const result = await checkReadiness([
      { name: "postgres", check: () => Promise.reject(new Error("secret connection string")) },
      { name: "redis", check: () => Promise.resolve() },
    ]);
    expect(result).toEqual({
      ready: false,
      dependencies: { postgres: "failed", redis: "ok" },
      failed: ["postgres"],
    });
    expect(JSON.stringify(result)).not.toContain("secret connection string");
  });
});
