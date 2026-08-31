import { and, eq, lte } from "drizzle-orm";
import { getDb } from "./index";
import { health } from "./schema";

/**
 * Claim a timestamp lease with one conditional update.
 *
 * A killed Worker cannot release its lease, so the value is an expiry rather
 * than a boolean. The conditional release also prevents an old invocation
 * from clearing a newer invocation's claim.
 */
export async function claimLease(id: string, lifetimeMs: number): Promise<number | null> {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + lifetimeMs;

  await db.insert(health).values({ id, value: 0 }).onConflictDoNothing({ target: health.id });
  const [claimed] = await db
    .update(health)
    .set({ value: expiresAt })
    .where(and(eq(health.id, id), lte(health.value, now)))
    .returning({ value: health.value });

  return claimed?.value === expiresAt ? expiresAt : null;
}

export async function releaseLease(id: string, token: number): Promise<void> {
  const db = getDb();
  await db
    .update(health)
    .set({ value: 0 })
    .where(and(eq(health.id, id), eq(health.value, token)));
}
