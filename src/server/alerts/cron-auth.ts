/**
 * Behörighet för schemalagda jobb: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron skickar
 * hemligheten så). Jämförs i konstant tid. Saknas hemligheten, eller är den kortare än 16
 * tecken, nekas alla anrop.
 */

import { timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 16;

export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const given = Buffer.from(header, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
