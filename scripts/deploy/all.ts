/**
 * Driftsätter hela Binderlab: Supabase (utveckling och produktion), Vercel
 * och (med --agare) ägarens konto. Idempotent; --dry-run visar planen.
 *
 *   npx tsx scripts/deploy/all.ts --dry-run
 *   npx tsx scripts/deploy/all.ts --agare ägare@exempel.se
 *
 * Se docs/driftsattning.md.
 */

import { main } from "./lib/main";

void main(["supabase", "vercel", "invite"]);
