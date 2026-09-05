import { describe, expect, it } from "vitest";
import { assertSafeResetDatabase, databaseName } from "@handoff/config";

describe("demo reset guard", () => {
  it("accepts explicitly named development demo databases", () => {
    expect(databaseName("postgresql://app:app@localhost/handoff_control_tower_demo")).toBe(
      "handoff_control_tower_demo",
    );
    expect(() =>
      assertSafeResetDatabase({
        appEnv: "development",
        databaseUrl: "postgresql://app:app@localhost/handoff_control_tower_demo",
      }),
    ).not.toThrow();
  });

  it("rejects production and unrelated database names", () => {
    expect(() =>
      assertSafeResetDatabase({
        appEnv: "production",
        databaseUrl: "postgresql://app:app@localhost/handoff_control_tower_demo",
      }),
    ).toThrow("Refusing reset");
    expect(() =>
      assertSafeResetDatabase({
        appEnv: "test",
        databaseUrl: "postgresql://app:app@localhost/customer_database",
      }),
    ).toThrow("Refusing reset");
  });
});
