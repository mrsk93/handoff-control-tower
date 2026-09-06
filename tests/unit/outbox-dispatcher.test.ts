import { describe, expect, it } from "vitest";
import { calculateOutboxRetryAt } from "@handoff/queue";

describe("outbox retry policy", () => {
  it("caps exponential delay and applies bounded jitter", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(
      calculateOutboxRetryAt(
        now,
        3,
        {
          baseDelayMs: 100,
          maxDelayMs: 250,
          jitterMs: 10,
        },
        1,
      ),
    ).toEqual(new Date("2026-01-01T00:00:00.260Z"));
    expect(
      calculateOutboxRetryAt(
        now,
        1,
        {
          baseDelayMs: 100,
          maxDelayMs: 250,
          jitterMs: 10,
        },
        0,
      ),
    ).toEqual(new Date("2026-01-01T00:00:00.090Z"));
  });
});
