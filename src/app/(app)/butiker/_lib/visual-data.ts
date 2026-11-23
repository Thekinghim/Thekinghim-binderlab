/**
 * Läsning för butikernas bilder (visuellt/06). Bara läsning, inga belopp:
 *
 *   - loadStoreFaces: butikens typ och stad (StoreFace) och läget (kartan), som den inloggade
 *     (RLS). Inga kontaktuppgifter.
 *   - loadShopVisuals: mest sålda pack, sålda pack och kurvan per butik i perioden (antal
 *     order ur periodens indata), senast påfylld per butik, och platserna i expansionen
 *     (öppna steg) för de streckade ringarna på kartan.
 *
 * Allt är dekor: ett fel ger tomma data, sidan visas ändå.
 */

import "server-only";

import { eq } from "drizzle-orm";
import { cache } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import * as s from "@/db/schema";
import { withUserDbFor } from "@/server/access";
import { loadContext, loadPeriod, requireViewer } from "@/server/data/core";
import { requestPageLoaders } from "@/server/data/page-loaders";
import { loadFleetState } from "@/server/data/v2/fleet";

import { loadLeadsFor } from "../../expansion/_lib/service";
import { OPEN_STAGES, LEAD_STAGE_LABEL } from "../../expansion/_lib/model";
import { storeSales, type StoreSales } from "./visual-model";

export interface StoreFaceInfo {
  readonly name: string;
  readonly storeType: string | null;
  readonly city: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

/** Butikernas typ, stad och läge (id → info). Som den inloggade; fel ger en tom karta. */
export const loadStoreFaces = cache(async (): Promise<Map<string, StoreFaceInfo>> => {
  try {
    const viewer = await requireViewer();
    const rows = await withUserDbFor(viewer.user, (tx) =>
      tx
        .select({
          id: s.stores.id,
          name: s.stores.name,
          storeType: s.stores.storeType,
          city: s.stores.city,
          lat: s.stores.latitude,
          lng: s.stores.longitude,
        })
        .from(s.stores)
        .where(eq(s.stores.organizationId, viewer.organization.id)),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          storeType: r.storeType?.trim() || null,
          city: r.city?.trim() || null,
          location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
        },
      ]),
    );
  } catch (error) {
    console.error("[butiker/visuellt] Butikernas typ och stad kunde inte läsas:", error);
    return new Map();
  }
});

/** Ett ansikte till klienten: bara det StoreFace behöver. */
export interface FaceProps {
  readonly storeType: string | null;
  readonly city: string | null;
}

export function faceOf(
  faces: ReadonlyMap<string, StoreFaceInfo>,
  storeId: string | null | undefined,
): FaceProps {
  const f = storeId ? faces.get(storeId) : undefined;
  return { storeType: f?.storeType ?? null, city: f?.city ?? null };
}

export interface LeadPin {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly storeType: string | null;
  /** "Möte 2 dec", "Kontaktad", "Intressent"… */
  readonly stage: string;
  /** Steget är bokat (möte eller avtal): gul etikett. */
  readonly warm: boolean;
}

export interface ShopVisuals {
  readonly faces: Readonly<Record<string, FaceProps & { lat: number | null; lng: number | null }>>;
  readonly sales: Readonly<Record<string, StoreSales>>;
  /** Senast påfylld per butik (ISO-tid), den senaste av butikens automater. */
  readonly lastRefill: Readonly<Record<string, string>>;
  readonly leads: readonly LeadPin[];
}

const SHORT_MONTH = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

function leadStage(stage: string, nextStepOn: string | null): string {
  const label = LEAD_STAGE_LABEL[stage as keyof typeof LEAD_STAGE_LABEL] ?? stage;
  if (nextStepOn && (stage === "meeting" || stage === "contacted" || stage === "agreement")) {
    const m = SHORT_MONTH[Number(nextStepOn.slice(5, 7)) - 1] ?? "";
    return `${label} ${Number(nextStepOn.slice(8, 10))} ${m}`;
  }
  return label;
}

async function leadsOrEmpty(): Promise<LeadPin[]> {
  try {
    const leads = await loadLeadsFor(await requireViewer());
    const order = new Map<string, number>(OPEN_STAGES.map((st, i) => [st, i]));
    return leads
      .filter((l) => !l.archived && l.storeId === null && order.has(l.stage))
      .sort((a, b) => (order.get(b.stage) ?? 0) - (order.get(a.stage) ?? 0))
      .map((l) => ({
        id: l.id,
        name: l.name,
        city: l.city?.trim() || null,
        storeType: l.storeType?.trim() || null,
        stage: leadStage(l.stage, l.nextStepOn),
        warm: l.stage === "meeting" || l.stage === "agreement",
      }));
  } catch (error) {
    console.error("[butiker/visuellt] Expansionens platser kunde inte läsas:", error);
    return [];
  }
}

async function salesOrEmpty(sp: SearchParamsInput): Promise<Map<string, StoreSales>> {
  try {
    const p = await loadPeriod(sp);
    const input = await requestPageLoaders().domainInput({ period: p.period });
    const names = new Map(input.titles.map((t) => [t.id, t]));
    const titleName = (id: string): string | null => {
      let t = names.get(id);
      // Sammanslagen titel: räkna på den den slogs ihop med.
      for (let i = 0; i < 4 && t?.mergedIntoId; i++) t = names.get(t.mergedIntoId) ?? t;
      return t?.name ?? null;
    };
    return storeSales({
      sales: input.current.orders,
      placements: input.current.placements,
      titleName,
      period: p.period,
    });
  } catch (error) {
    console.error("[butiker/visuellt] Sålda pack per butik kunde inte räknas:", error);
    return new Map();
  }
}

/** Butikernas bilder för Butiker (ägare, admin, läsare; rutten kontrolleras av sidan). */
export async function loadShopVisuals(sp: SearchParamsInput): Promise<ShopVisuals> {
  const ctx = await loadContext();
  const [faces, sales, leads, fleet] = await Promise.all([
    loadStoreFaces(),
    salesOrEmpty(sp),
    ctx.canSeeEconomy ? leadsOrEmpty() : Promise.resolve([]),
    loadFleetState().catch(() => null),
  ]);
  const lastRefill: Record<string, string> = {};
  for (const m of fleet?.machines ?? []) {
    if (!m.store || !m.lastRefillAt) continue;
    const cur = lastRefill[m.store.id];
    if (!cur || cur < m.lastRefillAt) lastRefill[m.store.id] = m.lastRefillAt;
  }
  return {
    faces: Object.fromEntries(
      [...faces].map(([id, f]) => [
        id,
        {
          storeType: f.storeType,
          city: f.city,
          lat: f.location?.lat ?? null,
          lng: f.location?.lng ?? null,
        },
      ]),
    ),
    sales: Object.fromEntries(sales),
    lastRefill,
    leads,
  };
}

export interface StoreBannerData {
  readonly face: FaceProps;
  readonly sales: StoreSales | null;
}

/** En butiks banner (butikens sida): symbolen och de mest sålda packen i perioden. */
export async function loadStoreBanner(
  storeId: string,
  sp: SearchParamsInput,
): Promise<StoreBannerData> {
  const [faces, sales] = await Promise.all([loadStoreFaces(), salesOrEmpty(sp)]);
  return { face: faceOf(faces, storeId), sales: sales.get(storeId) ?? null };
}
