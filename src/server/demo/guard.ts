/**
 * Demoorganisationer (organizations.is_demo) skickar aldrig något till omvärlden:
 * inga inbjudningar, inget mejl, ingen push och inga anrop till Awish eller andra
 * tjänster med demons data. Databasen spärrar inbjudningar och Awish-källor
 * (20261108000000_demo_kunder.sql); här är samma spärr för serverns egna flöden
 * (mejl, push, cron) och meddelandena som visas.
 */

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import { withUserDbFor, type SessionUser } from "@/server/access";

export const DEMO_MESSAGES = {
  invites: "Det här är en demo – inbjudningar är avstängda.",
  integrations: "Det här är en demo – kopplingar till Awish och andra tjänster är avstängda.",
  email: "Det här är en demo – e-post och notiser är avstängda.",
} as const;

/** Är organisationen en demo? Läses med den anslutning man har (under RLS eller som server). */
export async function isDemoOrganization(
  executor: Db | Tx,
  organizationId: string,
): Promise<boolean> {
  const result = await executor.execute(
    sql`select is_demo from public.organizations where id = ${organizationId}::uuid`,
  );
  const row = Array.from(result)[0] as { is_demo?: unknown } | undefined;
  return row?.is_demo === true;
}

/** Är organisationen en demo? Läses som användaren (RLS); okänd organisation räknas som demo. */
export async function isDemoFor(user: SessionUser, organizationId: string): Promise<boolean> {
  return withUserDbFor(user, async (tx) => {
    const result = await tx.execute(
      sql`select is_demo from public.organizations where id = ${organizationId}::uuid`,
    );
    const row = Array.from(result)[0] as { is_demo?: unknown } | undefined;
    return row?.is_demo !== false;
  });
}
