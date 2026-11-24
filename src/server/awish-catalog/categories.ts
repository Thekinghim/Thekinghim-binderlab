/**
 * Kategorier i Awish (Categories, CreateCategory, UpdateCategory, DeleteCategory) och
 * "Kategori per fack" (BatchUpdateProducts). Kategorierna syns som flikar på automatens
 * skärm. Bara ägare och admin; demo ansluter aldrig. Varje skrivning: förhandsvisning,
 * fingeravtryck, idempotensnyckel och loggrad (runControlAction).
 */

import "server-only";

import { runControlAction } from "@/server/awish/control/guard";
import type { AwishCategory, AwishProductDetail } from "@/server/awish/control/types";
import { linkedMachines, type LinkedMachine } from "@/server/awish/marketing";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

import {
  awishIdOf,
  catalogPreview,
  CatalogError,
  dbOf,
  keyOf,
  outcomeOf,
  readErrorMessage,
  requireOperator,
  STALE_MESSAGE,
  withReadClient,
  type CatalogDeps,
  type CatalogOutcome,
  type CatalogPreview,
} from "./common";

export const MAX_CATEGORY_TITLE = 40;
export const MAX_PRIORITY = 9999;

// ---------------------------------------------------------------------------
// Rena planer
// ---------------------------------------------------------------------------

export type CategoryChange =
  | { action: "create"; title: string; priority?: number; isVisible?: boolean }
  | { action: "update"; id: string; title?: string; priority?: number; isVisible?: boolean }
  | { action: "delete"; id: string };

function cleanTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (t === "") throw new CatalogError("Skriv ett namn på kategorin.");
  if (t.length > MAX_CATEGORY_TITLE)
    throw new CatalogError(`Namnet får vara högst ${MAX_CATEGORY_TITLE} tecken.`);
  return t;
}

function cleanPriority(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY)
    throw new CatalogError(`Ordningen är ett heltal 0–${MAX_PRIORITY}.`);
  return n;
}

function cleanVisible(raw: unknown): boolean | undefined {
  if (raw === true || raw === "true" || raw === "ja") return true;
  if (raw === false || raw === "false" || raw === "nej") return false;
  return undefined;
}

/** Formulärets värden → en ändring (kastar CatalogError med svensk text). */
export function parseCategoryChange(raw: unknown): CategoryChange {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.action === "create") {
    const title = cleanTitle(r.title ?? "");
    return {
      action: "create",
      title: title!,
      priority: cleanPriority(r.priority),
      isVisible: cleanVisible(r.isVisible) ?? true,
    };
  }
  if (r.action === "update") {
    const change = {
      action: "update" as const,
      id: awishIdOf(r.id, "Välj kategori."),
      title: cleanTitle(r.title === "" ? undefined : r.title),
      priority: cleanPriority(r.priority),
      isVisible: cleanVisible(r.isVisible),
    };
    if (
      change.title === undefined &&
      change.priority === undefined &&
      change.isVisible === undefined
    )
      throw new CatalogError("Inget är ändrat.");
    return change;
  }
  if (r.action === "delete") return { action: "delete", id: awishIdOf(r.id, "Välj kategori.") };
  throw new CatalogError("Okänd ändring.");
}

export function planCategoryChange(
  change: CategoryChange,
  categories: readonly AwishCategory[],
): { lines: string[]; blocking: string | null; confirm: string | null } {
  const current = change.action === "create" ? null : categories.find((c) => c.id === change.id);
  if (change.action !== "create" && !current) {
    return { lines: [], blocking: "Kategorin finns inte längre. Ladda om sidan.", confirm: null };
  }
  const visible = (v: boolean | undefined) =>
    v === undefined ? null : v ? "Visas på skärmen." : "Visas inte på skärmen.";
  if (change.action === "create") {
    const same = categories.find((c) => c.title.toLowerCase() === change.title.toLowerCase());
    return {
      lines: [
        `Ny kategori ${change.title}.`,
        ...(change.priority === undefined ? [] : [`Ordning ${change.priority}.`]),
        visible(change.isVisible)!,
      ],
      blocking: same ? `Det finns redan en kategori som heter ${same.title}.` : null,
      confirm: null,
    };
  }
  if (change.action === "update") {
    const lines: string[] = [];
    if (change.title !== undefined && change.title !== current!.title)
      lines.push(`${current!.title} → ${change.title}.`);
    if (change.priority !== undefined) lines.push(`Ordning ${change.priority}.`);
    const v = visible(change.isVisible);
    if (v) lines.push(v);
    if (lines.length === 0) return { lines, blocking: "Inget är ändrat.", confirm: null };
    return { lines: [`${current!.title}:`, ...lines], blocking: null, confirm: null };
  }
  return {
    lines: [`${current!.title} tas bort i Awish.`],
    blocking: null,
    confirm: `Ta bort ${current!.title}? Facken i kategorin hamnar utan kategori.`,
  };
}

// ---------------------------------------------------------------------------
// Sidan
// ---------------------------------------------------------------------------

export type CategoriesPage =
  | { status: "demo"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; categories: AwishCategory[]; machines: LinkedMachine[] };

export async function loadCategoriesPageFor(
  viewer: Viewer,
  deps: CatalogDeps = {},
): Promise<CategoriesPage> {
  await requireOperator(viewer);
  const db = dbOf(deps);
  if (await isDemoOrganization(db, viewer.organization.id)) {
    return { status: "demo", message: DEMO_MESSAGES.integrations };
  }
  try {
    return await withReadClient(viewer, deps, async ({ api }) => ({
      status: "ok" as const,
      categories: await api.categories(),
      machines: await linkedMachines(db, viewer.organization.id),
    }));
  } catch (error) {
    if (error instanceof CatalogError) return { status: "error", message: error.message };
    return { status: "error", message: readErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Skapa, ändra, ta bort
// ---------------------------------------------------------------------------

async function computeCategory(viewer: Viewer, raw: unknown, deps: CatalogDeps) {
  const change = parseCategoryChange(raw);
  const categories = await withReadClient(viewer, deps, ({ api }) => api.categories());
  const plan = planCategoryChange(change, categories);
  const fingerprint = catalogPreview(plan, { change }).fingerprint;
  return { change, plan, fingerprint };
}

export async function previewCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const change = parseCategoryChange(raw);
  const categories = await withReadClient(viewer, deps, ({ api }) => api.categories());
  return catalogPreview(planCategoryChange(change, categories), { change });
}

export async function applyCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const { change, plan, fingerprint } = await computeCategory(viewer, raw, deps);
  if (plan.blocking) throw new CatalogError(plan.blocking);
  if (fingerprint !== r.fingerprint) throw new CatalogError(STALE_MESSAGE);
  const run = deps.run ?? runControlAction;
  if (change.action === "create") {
    const result = await run(
      viewer,
      {
        kind: "category_create",
        idempotencyKey: key,
        auditRequest: {
          title: change.title,
          priority: change.priority ?? null,
          is_visible: change.isVisible ?? null,
        },
      },
      (api) =>
        api.createCategory({
          title: change.title,
          ...(change.priority === undefined ? {} : { priority: change.priority }),
          ...(change.isVisible === undefined ? {} : { isVisible: change.isVisible }),
        }),
      deps,
    );
    return outcomeOf(result, `Klart! ${change.title} finns nu i Awish.`);
  }
  if (change.action === "update") {
    const patch = {
      id: change.id,
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.priority === undefined ? {} : { priority: change.priority }),
      ...(change.isVisible === undefined ? {} : { isVisible: change.isVisible }),
    };
    const result = await run(
      viewer,
      { kind: "category_update", targetId: change.id, idempotencyKey: key, auditRequest: patch },
      (api) => api.updateCategory(patch),
      deps,
    );
    return outcomeOf(result, "Klart! Kategorin är ändrad i Awish.");
  }
  const result = await run(
    viewer,
    {
      kind: "category_delete",
      targetId: change.id,
      idempotencyKey: key,
      auditRequest: { id: change.id },
    },
    (api) => api.deleteCategory(change.id),
    deps,
  );
  return outcomeOf(result, "Klart! Kategorin är borttagen i Awish.");
}

// ---------------------------------------------------------------------------
// Kategori per fack (BatchUpdateProducts)
// ---------------------------------------------------------------------------

export interface CategorySlot {
  readonly id: string;
  readonly label: string;
}

function slotLabel(p: AwishProductDetail): string {
  const name = p.channel?.name || `Fack ${p.id}`;
  return p.goodName ? `${name} · ${p.goodName}` : `${name} · tomt`;
}

async function machineOf(viewer: Viewer, machineId: unknown, deps: CatalogDeps) {
  const id = typeof machineId === "string" ? machineId : "";
  const machine = (await linkedMachines(dbOf(deps), viewer.organization.id)).find(
    (m) => m.machineId === id,
  );
  if (!machine) throw new CatalogError("Välj en automat som är kopplad till Awish.");
  return machine;
}

/** Facken på automaten (för väljaren). */
export async function categorySlotsFor(
  viewer: Viewer,
  machineId: unknown,
  deps: CatalogDeps = {},
): Promise<CategorySlot[]> {
  return withReadClient(viewer, deps, async ({ api }) => {
    const machine = await machineOf(viewer, machineId, deps);
    return (await api.productDetails(machine.awishMachineId)).map((p) => ({
      id: p.id,
      label: slotLabel(p),
    }));
  });
}

async function computeBatch(viewer: Viewer, raw: unknown, deps: CatalogDeps) {
  const r = (raw ?? {}) as { machineId?: unknown; productIds?: unknown; categoryId?: unknown };
  const categoryId = awishIdOf(r.categoryId, "Välj kategori.");
  const wanted = Array.isArray(r.productIds) ? r.productIds.map(String) : [];
  if (wanted.length === 0) throw new CatalogError("Välj minst ett fack.");
  if (wanted.length > 200) throw new CatalogError("Högst 200 fack åt gången.");
  return withReadClient(viewer, deps, async ({ api }) => {
    const machine = await machineOf(viewer, r.machineId, deps);
    const [products, categories] = [
      await api.productDetails(machine.awishMachineId),
      await api.categories(),
    ];
    const category = categories.find((c) => c.id === categoryId);
    const slots = products.filter((p) => wanted.includes(p.id));
    const blocking = !category
      ? "Kategorin finns inte längre. Ladda om sidan."
      : slots.length !== new Set(wanted).size
        ? "Något fack finns inte längre. Ladda om sidan."
        : null;
    const plan = {
      lines: blocking
        ? []
        : [
            `${slots.length} fack på ${machine.code || machine.name} → ${category!.title}:`,
            slots.map((p) => p.channel?.name || p.id).join(", "),
          ],
      blocking,
    };
    const ids = slots.map((p) => p.id).sort();
    return {
      machine,
      categoryId,
      ids,
      plan,
      fingerprint: catalogPreview(plan, { machine: machine.machineId, categoryId, ids })
        .fingerprint,
    };
  });
}

export async function previewBatchCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const { plan, machine, categoryId, ids } = await computeBatch(viewer, raw, deps);
  return catalogPreview(plan, { machine: machine.machineId, categoryId, ids });
}

export async function applyBatchCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const { plan, machine, categoryId, ids, fingerprint } = await computeBatch(viewer, raw, deps);
  if (plan.blocking) throw new CatalogError(plan.blocking);
  if (fingerprint !== r.fingerprint) throw new CatalogError(STALE_MESSAGE);
  const result = await (deps.run ?? runControlAction)(
    viewer,
    {
      kind: "products_batch",
      machineId: machine.machineId,
      idempotencyKey: key,
      auditRequest: { machine_id: machine.awishMachineId, ids, category_id: categoryId },
    },
    (api) => api.batchUpdateProducts({ machineId: machine.awishMachineId, ids, categoryId }),
    deps,
  );
  return outcomeOf(result, `Klart! ${ids.length} fack har fått ny kategori.`);
}

/** Kategorierna i Awish (för väljaren på en vara). */
export async function categoryListFor(
  viewer: Viewer,
  deps: CatalogDeps = {},
): Promise<AwishCategory[]> {
  return withReadClient(viewer, deps, ({ api }) => api.categories());
}
