/**
 * awish_grpc: målet för hämtningen (schemalagt jobb var 10:e minut), men det
 * går inte att bygga förrän Awish har lämnat specifikationen. Tills dess
 * kastar adaptern NotConfiguredError med en lista över vad som saknas, så att
 * ingen tror att den fungerar. Se docs/awish.md.
 */

import type { AdapterInput, SourceAdapter } from "../adapter";
import { ImportValidationError, NotConfiguredError } from "../errors";

/** Det vi behöver från Awish innan adaptern kan byggas (samma lista som i docs/awish.md). */
export const AWISH_GRPC_MISSING: readonly string[] = [
  ".proto-filerna för order- och automattjänsterna (meddelanden, metoder, paginering/markör)",
  "Hur token beräknas för app-ID (algoritm, vilka fält som ingår, giltighetstid, exempel med kända värden)",
  "TLS-inställningar: värdnamn, port, om klientcertifikat krävs, CA-kedja",
  "Det tredje metadatafältet i anropen (namn, format och hur värdet tas fram)",
  "Webhook-dokumentation: händelsetyper, signering/verifiering, omförsök",
  "Exempelpayload för en betald order (gRPC-svar och webhook) inklusive tidszon och beloppsformat",
];

export type AwishGrpcInput = AdapterInput;

/**
 * Hemligheten ska ligga i organisationens namnrymd i Vault
 * ("{organization_id}/namn"). Kontrolleras innan Vault läses, samma regel som
 * check-villkoret på data_sources.secret_ref.
 */
export function assertSecretRefInNamespace(
  organizationId: string,
  secretRef: string | null,
): string {
  if (!secretRef) {
    throw new ImportValidationError("Datakällan saknar hemlighet (secret_ref).");
  }
  const prefix = `${organizationId}/`;
  const name = secretRef.slice(prefix.length);
  if (!secretRef.startsWith(prefix) || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,150}$/.test(name)) {
    throw new ImportValidationError("Hemligheten ligger inte i organisationens namnrymd.");
  }
  return secretRef;
}

export const awishGrpcAdapter: SourceAdapter<AwishGrpcInput> = {
  provider: "awish_grpc",
  async fetch(input) {
    // En felaktig hemlighetsreferens stoppas redan nu, även innan gRPC finns.
    if (input.context.secretRef !== null) {
      assertSecretRefInNamespace(input.context.organizationId, input.context.secretRef);
    }
    throw new NotConfiguredError(
      "Awish gRPC är inte konfigurerat ännu. Använd CSV-uppladdning tills Awish har lämnat:",
      AWISH_GRPC_MISSING,
    );
  },
};
