/**
 * Adapter för bokföringsprogram (Fortnox, Visma eEkonomi/eNet, Bokio).
 *
 * Verifikationerna räknas fram i @/reports (sie4Verifications) och är desamma oavsett
 * program. Adaptern bara levererar dem. Beställaren har inte valt program, så:
 *
 * - `none` (standard): ej konfigurerad. Sidan visar läget och SIE-filen som väg in i
 *   valfritt program (alla tre läser SIE 4).
 * - `local`: skriver SIE-filen och en JSON med verifikationerna till en katalog
 *   (.data/outbox/bokforing), för utveckling och test av flödet.
 * - `fortnox`, `visma_enet`, `bokio`: känns igen men är inte byggda. De rapporterar
 *   "ej konfigurerad" med vad som behövs, tills beställaren valt program och skaffat
 *   API-nycklar. Gränssnittet nedan är det en riktig implementation ska uppfylla.
 */

import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Sie4Verification } from "@/reports";

import { accountingConfig, type AccountingConfig, type AccountingProviderKind } from "./config";

export interface BookkeepingStatus {
  readonly kind: AccountingProviderKind;
  readonly configured: boolean;
  /** Programmets namn, t.ex. "Fortnox". */
  readonly label: string;
  /** En mening om läget. */
  readonly detail: string;
}

/** En månads verifikationer att leverera. */
export interface VoucherBatch {
  readonly organizationId: string;
  /** 'ÅÅÅÅ-MM'. */
  readonly month: string;
  readonly verifications: readonly Sie4Verification[];
  /** SIE 4-filen (CP437) med samma verifikationer. */
  readonly sieFile: Uint8Array;
  readonly fileName: string;
}

export interface VoucherDelivery {
  /** Var verifikationerna hamnade (sökväg eller programmets id). */
  readonly location: string;
  readonly count: number;
}

export interface BookkeepingAdapter {
  readonly kind: AccountingProviderKind;
  status(): BookkeepingStatus;
  /** Levererar verifikationerna. Kastar `BookkeepingNotConfiguredError` om inget program är kopplat. */
  deliver(batch: VoucherBatch): Promise<VoucherDelivery>;
}

export class BookkeepingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookkeepingNotConfiguredError";
  }
}

const LABEL: Record<AccountingProviderKind, string> = {
  none: "Inget bokföringsprogram",
  local: "Lokal utkorg",
  fortnox: "Fortnox",
  visma_enet: "Visma eEkonomi",
  bokio: "Bokio",
};

/** Det som krävs för varje program innan en riktig adapter kan byggas och slås på. */
const REQUIREMENTS: Record<"fortnox" | "visma_enet" | "bokio", string> = {
  fortnox:
    "Fortnox kräver en integration i Fortnox utvecklarportal (klient-id och hemlighet) och ett godkännande från bolagets Fortnox-konto.",
  visma_enet:
    "Visma eEkonomi kräver ett avtal i Visma Developer (klient-id och hemlighet) och ett godkännande från bolagets konto.",
  bokio: "Bokio kräver en API-nyckel från bolagets Bokio-konto (Inställningar → Integrationer).",
};

class NotConfiguredBookkeeping implements BookkeepingAdapter {
  constructor(
    readonly kind: AccountingProviderKind,
    private readonly detail: string,
  ) {}

  status(): BookkeepingStatus {
    return { kind: this.kind, configured: false, label: LABEL[this.kind], detail: this.detail };
  }

  async deliver(): Promise<VoucherDelivery> {
    throw new BookkeepingNotConfiguredError(this.detail);
  }
}

/** Skriver verifikationerna till en katalog: SIE-filen och en JSON med samma innehåll. */
export class LocalOutboxBookkeeping implements BookkeepingAdapter {
  readonly kind = "local" as const;

  constructor(private readonly dir: string) {}

  status(): BookkeepingStatus {
    return {
      kind: "local",
      configured: true,
      label: LABEL.local,
      detail: "Verifikationerna skrivs som SIE-fil till utvecklingsmiljöns utkorg.",
    };
  }

  async deliver(batch: VoucherBatch): Promise<VoucherDelivery> {
    if (!/^\d{4}-\d{2}$/.test(batch.month)) throw new RangeError("Ogiltig månad.");
    const dir = path.join(this.dir, batch.organizationId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(dir, `${batch.month}_${stamp}`);
    await writeFile(`${base}.se`, batch.sieFile);
    await writeFile(
      `${base}.json`,
      JSON.stringify({ month: batch.month, verifications: batch.verifications }, null, 2),
    );
    return { location: `${base}.se`, count: batch.verifications.length };
  }
}

/** Adaptern enligt ACCOUNTING_PROVIDER. */
export function bookkeepingAdapter(
  config: AccountingConfig = accountingConfig(),
): BookkeepingAdapter {
  switch (config.provider) {
    case "local":
      return new LocalOutboxBookkeeping(config.outboxDir);
    case "fortnox":
    case "visma_enet":
    case "bokio":
      return new NotConfiguredBookkeeping(
        config.provider,
        `${LABEL[config.provider]} är valt men inte kopplat. ${REQUIREMENTS[config.provider]}`,
      );
    case "none":
    default:
      return new NotConfiguredBookkeeping(
        "none",
        config.providerInvalid
          ? `ACCOUNTING_PROVIDER har ett okänt värde (${config.providerInvalid}). Inget program är kopplat.`
          : "Inget bokföringsprogram är kopplat. SIE-filen läses av Fortnox, Visma och Bokio.",
      );
  }
}
