/**
 * Supabase: produktionsprojektet (skapas om det saknas), nycklar, auth,
 * JWT-nycklar, migreringar och buckets i båda projekten. Läser Vercel (om
 * VERCEL_TOKEN finns) för adresserna, men ändrar inget där.
 *
 *   npx tsx scripts/deploy/supabase.ts [--dry-run] [--app-url https://…]
 *
 * Se docs/driftsattning.md.
 */

import { main } from "./lib/main";

void main(["supabase"]);
