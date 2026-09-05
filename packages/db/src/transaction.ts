import type { Database } from "./client";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function inTransaction<T>(
  db: Database,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(operation);
}
