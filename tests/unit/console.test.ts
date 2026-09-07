import { describe, expect, it } from "vitest";
import { ConsoleController } from "../../apps/api/src/console.controller";

describe("operator console surface", () => {
  it("renders the operator views without connecting to persistence", () => {
    const html = new ConsoleController().index();
    expect(html).toContain("Handoff Control Tower");
    expect(html).toContain("Orders");
    expect(html).toContain("Exception queue");
    expect(html).toContain("Run bounded reconciliation");
    expect(html).toContain("Demo Simulator");
    expect(html).toContain("Data may be stale");
  });
});
