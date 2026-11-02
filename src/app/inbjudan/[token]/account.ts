import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";

/**
 * Finns det redan ett konto med lösenord för adressen? Bara för den lokala
 * dev-inloggningen (auth.users i auth-shimmen), så att /inbjudan/[token]
 * direkt kan visa "Logga in och gå med" i stället för att låta personen välja
 * ett lösenord som sedan avvisas.
 *
 * Anropas bara för en giltig inbjudan och bara med inbjudans egen adress:
 * den som har länken är den inbjudna, så svaret avslöjar inget om andra
 * adresser. Läser ingen organisationsdata.
 */
export async function devAccountExists(
  email: string,
  db: () => Db = getServiceDb,
): Promise<boolean> {
  const result = await db().execute(
    sql`select 1 from auth.users
        where lower(email::text) = ${email.trim().toLowerCase()}
          and encrypted_password is not null
        limit 1`,
  );
  return Array.from(result).length > 0;
}
