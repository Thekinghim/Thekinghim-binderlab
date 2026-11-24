/**
 * Samma lås per organisation som webbvägen (withAwishWriteLock i new-product.ts), men som
 * väntar (högst 15 s) i stället för att ge upp direkt. Används av påfyllningen via API:t,
 * som inte har någon användare som kan trycka igen. Låset hålls i en transaktion medan
 * anropen pågår och släpps när den avslutas (även vid fel).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

export function awishWriteLockKey(orgId: string): string {
  return `binderlab:awish-produkt:${orgId}`;
}

export async function withAwishWriteLockWait<T>(
  db: Db,
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '15s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${awishWriteLockKey(orgId)}, 0))`,
    );
    return fn();
  });
}
