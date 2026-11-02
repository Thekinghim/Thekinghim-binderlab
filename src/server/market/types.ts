/**
 * Typer för Marknad (fas 11) på servern: raderna ur marknadstabellerna och allt underlag
 * som sidan /marknad räknar på. Belopp i öre, andelar i bp, affärsdatum 'ÅÅÅÅ-MM-DD'.
 */

import type { AnalyticsOrder } from "@/analytics/todos";
import type { MemberRole } from "@/db/schema";
import type { EconomicsSources, IsoDate } from "@/domain";
import type { MasterData, OrgSettings } from "@/server/data/core/types";

/** Ett släpp i releasekalendern. */
export interface ReleaseRow {
  readonly id: string;
  readonly name: string;
  readonly series: string | null;
  readonly releaseDate: IsoDate;
  readonly titleId: string | null;
  readonly supplierId: string | null;
  readonly scaleBp: number;
  readonly horizonDays: number;
  readonly boxSize: number;
  readonly minOrderQty: number;
  readonly source: "manual" | "import";
  readonly note: string | null;
  /** Tidpunkt (ISO 8601) då förslaget fastställdes, annars null. */
  readonly planLockedAt: string | null;
  readonly planLockedBy: string | null;
  readonly planPurchaseUnits: number | null;
  readonly planCurveBp: readonly number[] | null;
  /** Förslagets text och underlag när det fastställdes. */
  readonly planText: string | null;
}

/** Fastställd fördelning per automat. */
export interface AllocationRow {
  readonly id: string;
  readonly releaseId: string;
  readonly machineId: string;
  readonly units: number;
  readonly suggestedUnits: number | null;
}

/** Ett registrerat inköpspris (offert eller inköp utan inköpsorder). */
export interface QuoteRow {
  readonly id: string;
  readonly supplierId: string;
  readonly titleId: string;
  readonly quotedOn: IsoDate;
  readonly validUntil: IsoDate | null;
  readonly unitCostOre: number;
  readonly quantity: number;
  readonly kind: "quote" | "purchase";
  readonly source: "manual" | "import" | "market";
  readonly note: string | null;
  readonly createdBy: string | null;
}

/** En inköpsorderrad med inköpsorderns leverantör och datum. */
export interface PurchaseLineRow {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly titleId: string;
  /** Beställningsdag, annars dagen inköpsordern skapades (i organisationens tidszon). */
  readonly date: IsoDate;
  readonly unitCostOre: number;
  readonly quantity: number;
  readonly status: string;
}

/** Fackfördelning: titel med N fack i en automat under en period. */
export interface SlotRow {
  readonly id: string;
  readonly machineId: string;
  readonly titleId: string;
  readonly slots: number;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
}

/** En genomförd sortimentsrekommendation. */
export interface AssortmentChangeRow {
  readonly id: string;
  readonly machineId: string;
  readonly implementedOn: IsoDate;
  readonly recommendationKey: string;
  readonly fingerprint: string;
  readonly expectedEffectPerWeekOre: number;
  readonly changedTitleIds: readonly string[];
  /** Rekommendationens text när den genomfördes. */
  readonly text: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** Ett startat pristest. */
export interface PriceExperimentRow {
  readonly id: string;
  readonly titleId: string;
  readonly proposalKey: string;
  readonly direction: "up" | "down";
  readonly fromOre: number;
  readonly toOre: number;
  readonly startedOn: IsoDate;
  readonly testDays: number;
  readonly stoppedOn: IsoDate | null;
  readonly testMachineIds: readonly string[];
  readonly controlMachineIds: readonly string[];
  /** Förslagets text när testet startades. */
  readonly text: string | null;
}

/** Leverantör. */
export interface SupplierRow {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

/** Leverantörsartikel: förpackning och minsta beställning per titel. */
export interface SupplierItemRow {
  readonly supplierId: string;
  readonly titleId: string;
  readonly packSize: number;
  readonly minOrderQty: number;
}

/** Allt /marknad räknar på, läst som användaren med RLS. */
export interface MarketData extends MasterData {
  readonly organizationId: string;
  readonly timeZone: string;
  readonly role: MemberRole;
  /** Ägare och admin. */
  readonly canEdit: boolean;
  /** Dagens affärsdatum. */
  readonly today: IsoDate;
  /** Första dagen med en order, eller null. */
  readonly dataStart: IsoDate | null;
  /** Första dagen i den inlästa orderhistoriken. */
  readonly historyStart: IsoDate;
  /** Order från historyStart till och med i dag. */
  readonly orders: readonly AnalyticsOrder[];
  /** Priser, avtal, placeringar och inställningar (hela organisationen). */
  readonly sources: EconomicsSources;
  readonly settings: OrgSettings;
  /** Pack i centrallagret per titel. */
  readonly warehouseUnits: ReadonlyMap<string, number>;
  readonly suppliers: readonly SupplierRow[];
  readonly supplierItems: readonly SupplierItemRow[];
  readonly purchaseLines: readonly PurchaseLineRow[];
  readonly releases: readonly ReleaseRow[];
  readonly allocations: readonly AllocationRow[];
  readonly quotes: readonly QuoteRow[];
  readonly slots: readonly SlotRow[];
  readonly assortmentChanges: readonly AssortmentChangeRow[];
  readonly experiments: readonly PriceExperimentRow[];
}
