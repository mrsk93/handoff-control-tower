import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export type Migration = {
  name: string;
  filePath: string;
};

const migrationsDirectory = join(__dirname, "..", "migrations");

export async function listMigrations(): Promise<Migration[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  return files.map((file) => ({
    name: file.replace(/\.sql$/, ""),
    filePath: join(migrationsDirectory, file),
  }));
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const appliedRows = await pool.query<{ name: string }>("select name from schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => row.name));
  const migrations = await listMigrations();
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const sql = await readFile(migration.filePath, "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into schema_migrations (name) values ($1)", [migration.name]);
      await pool.query("commit");
      newlyApplied.push(migration.name);
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
  return newlyApplied;
}

export async function resetPublicSchema(pool: Pool): Promise<void> {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
}
