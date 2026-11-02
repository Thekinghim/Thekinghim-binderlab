/**
 * Vercel: projektet kopplat till Thekinghim/thekinghim-binderlab,
 * funktionsregion arn1, miljövariabler för Production och Preview,
 * driftsättning från main och kontroll av /logga-in. Läser nycklarna från
 * Supabase (kräver att supabase.ts körts).
 *
 *   npx tsx scripts/deploy/vercel.ts [--dry-run] [--force-deploy | --skip-deploy]
 *
 * Se docs/driftsattning.md.
 */

import { main } from "./lib/main";

void main(["vercel"]);
