import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("domain package seam", () => {
  it("does not import infrastructure or vendor concerns", async () => {
    const files = await sourceFiles(join(process.cwd(), "packages/domain/src"));
    const forbidden = /@nestjs|drizzle|from ["']pg["']|ioredis|express|redis|shopify|wms/i;
    for (const file of files) {
      expect(forbidden.test(await readFile(file, "utf8"))).toBe(false);
    }
  });
});
