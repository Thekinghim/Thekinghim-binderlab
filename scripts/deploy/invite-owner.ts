/**
 * Lägger in ägarens konto i produktionsprojektets Supabase Auth (bekräftad
 * e-post, inget lösenord) och skriver vad ägaren gör sedan.
 *
 *   npx tsx scripts/deploy/invite-owner.ts ägare@exempel.se [--dry-run] [--miljo preview]
 *
 * Se docs/driftsattning.md.
 */

import { main } from "./lib/main";

void main(["invite"]);
