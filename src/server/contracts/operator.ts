/**
 * Vi i kontraktet (operatören): företagsuppgifterna från Inställningar → Företaget
 * (organization_settings, 20261106050000_foretagsuppgifter.sql). Organisationsnumret tas
 * från Bokföring när det finns där (samma nummer i SIE-filen och i kontraktet), annars från
 * Inställningar. Rena hjälpfunktioner testas i operator.test.ts; readOperator mot databasen
 * i test/db/foretagsuppgifter.test.ts.
 */

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import type { ContractParty } from "@/reports/contract-pdf";

/** Företagsuppgifterna som de står i databasen (null = inte ifyllt). */
export interface CompanyDetailsRow {
  readonly companyName: string | null;
  readonly orgNumber: string | null;
  readonly companyAddress: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

export const EMPTY_COMPANY: CompanyDetailsRow = {
  companyName: null,
  orgNumber: null,
  companyAddress: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
};

/** Kontraktets operatörsblock: juridiskt namn (eller organisationens namn) och uppgifterna. */
export function operatorParty(organizationName: string, row: CompanyDetailsRow): ContractParty {
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    name: clean(row.companyName) ?? organizationName,
    orgNumber: clean(row.orgNumber),
    address: clean(row.companyAddress),
    contactName: clean(row.contactName),
    email: clean(row.contactEmail),
    phone: clean(row.contactPhone),
  };
}

/** Raderna som blir tomma i kontraktet, i kontraktets ordning ("org.nr", "adress" …). */
export function operatorGaps(p: ContractParty): string[] {
  const gaps: string[] = [];
  if (!p.orgNumber) gaps.push("org.nr");
  if (!p.address) gaps.push("adress");
  if (!p.contactName) gaps.push("kontaktperson");
  if (!p.email) gaps.push("e-post");
  if (!p.phone) gaps.push("telefon");
  return gaps;
}

/** Företagsuppgifterna, med Bokföringens organisationsnummer före Inställningarnas. */
export async function readCompanyDetails(tx: Tx, orgId: string): Promise<CompanyDetailsRow> {
  const row = Array.from(
    await tx.execute(sql`
      select os.company_name, os.company_address, os.contact_name, os.contact_email,
             os.contact_phone,
             coalesce(
               (select bs.org_number from public.bookkeeping_settings bs
                 where bs.organization_id = ${orgId}::uuid),
               os.org_number
             ) as org_number
        from (select 1) one
        left join public.organization_settings os on os.organization_id = ${orgId}::uuid`),
  )[0] as Record<string, unknown> | undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return row
    ? {
        companyName: str(row.company_name),
        orgNumber: str(row.org_number),
        companyAddress: str(row.company_address),
        contactName: str(row.contact_name),
        contactEmail: str(row.contact_email),
        contactPhone: str(row.contact_phone),
      }
    : EMPTY_COMPANY;
}

/** Operatören i kontraktet för organisationen. */
export async function readOperator(
  tx: Tx,
  orgId: string,
  organizationName: string,
): Promise<ContractParty> {
  return operatorParty(organizationName, await readCompanyDetails(tx, orgId));
}
