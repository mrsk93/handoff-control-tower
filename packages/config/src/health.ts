export type DependencyProbe = {
  name: string;
  check(): Promise<void>;
};

export type ReadinessResult =
  | { ready: true; dependencies: Record<string, "ok"> }
  | { ready: false; dependencies: Record<string, "ok" | "failed">; failed: string[] };

export async function checkReadiness(probes: readonly DependencyProbe[]): Promise<ReadinessResult> {
  const entries = await Promise.all(
    probes.map(async (probe) => {
      try {
        await probe.check();
        return [probe.name, "ok"] as const;
      } catch {
        return [probe.name, "failed"] as const;
      }
    }),
  );
  const dependencies = Object.fromEntries(entries) as Record<string, "ok" | "failed">;
  const failed = entries.filter(([, status]) => status === "failed").map(([name]) => name);
  if (failed.length > 0) {
    return { ready: false, dependencies, failed };
  }
  return { ready: true, dependencies: dependencies as Record<string, "ok"> };
}
