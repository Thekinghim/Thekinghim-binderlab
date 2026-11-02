import type { IsoDate } from "@/domain";

import type { EvidenceNames } from "../_components/evidence";
import type { Option } from "./types";

/** Det alla sektioner på /marknad behöver utöver sin egen modell. */
export interface SectionContext {
  readonly today: IsoDate;
  /** Ägare och admin. Läsaren ser allt men kan inte ändra. */
  readonly canEdit: boolean;
  readonly names: EvidenceNames;
  /** Aktiva titlar (inte arkiverade eller sammanslagna). */
  readonly titleOptions: readonly Option[];
  readonly supplierOptions: readonly Option[];
  /** "leverantör:titel" → förpackning och minsta beställning. */
  readonly supplierItems: Readonly<Record<string, { packSize: number; minOrderQty: number }>>;
  /** Skalets parametrar (period och filter) för länkar inom sidan. */
  readonly query: Readonly<Record<string, string>>;
}
