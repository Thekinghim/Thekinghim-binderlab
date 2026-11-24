/**
 * GET /pengar/utbetalningar/export  Betallistan för banken (CSV): mottagare (butiker, bolag
 * och partnern) med något kvar att betala: namn, organisationsnummer, bankgiro, belopp och
 * meddelande ("Nayax 3–9 nov."). Semikolon, svenska decimaler och skydd mot formler i
 * kalkylprogrammet (src/lib/csv.ts). Bara ägare och admin.
 */

import { toCsv } from "@/lib/csv";
import { OPERATOR_ROLES, requireContextRole, requireViewer } from "@/server/data/core";
import { bankRows } from "@/server/payouts/balances";
import { loadPayoutsPageFor } from "@/server/payouts/service";
import { AuthorizationError } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await requireContextRole(OPERATOR_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response("Bara ägare och admin kan ladda ner betallistan.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
  const viewer = await requireViewer();
  const page = await loadPayoutsPageFor(viewer);
  const csv = toCsv(bankRows(page), [
    { header: "Mottagare", csv: (r) => r.name },
    { header: "Organisationsnummer", csv: (r) => r.orgNumber },
    { header: "Bankgiro", csv: (r) => r.bankgiro },
    { header: "Belopp (kr)", csv: (r) => r.amountKr },
    { header: "Meddelande", csv: (r) => r.message },
  ]);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="betallista-${page.today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
