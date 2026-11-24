/**
 * Medlemmar i Awish (Members, BatchCreateMembers, UpdateMember, DeleteMember).
 *
 * Integritet:
 *  - Bara ägare och admin. Påfyllare, butik, automatpåfyllare och läsare nekas före varje
 *    anrop; demo ansluter aldrig.
 *  - Listan läses direkt från Awish och sparas aldrig i Binderlab (ingen tabell, ingen cache).
 *    Telefon och e-post visas som Awish maskar dem.
 *  - Granskningsraden sparar bara medlemmens id och namnen på fälten som ändrades, aldrig
 *    värdena.
 *  - Saldo och lösenord ändras aldrig från Binderlab.
 */

import "server-only";

import { runControlAction } from "@/server/awish/control/guard";
import type {
  AwishControlApi,
  AwishMember,
  AwishMemberInput,
  AwishMemberPatch,
  AwishPage,
} from "@/server/awish/control/types";
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
  refuseDemo,
  requireOperator,
  STALE_MESSAGE,
  withReadClient,
  type CatalogDeps,
  type CatalogOutcome,
  type CatalogPreview,
} from "./common";

export const MEMBERS_FORBIDDEN = "Bara ägare och admin ser medlemmarna.";
export const MEMBERS_PER_PAGE = 25;
/** Högst så många sidor läses när en medlem letas upp (25 × 80 = 2 000 medlemmar). */
const MAX_FIND_PAGES = 80;

export const MEMBER_STATUS_LABEL: Record<number, string> = { 0: "Av", 1: "Aktiv", 2: "Fryst" };

export function memberStatusLabel(status: number): string {
  return MEMBER_STATUS_LABEL[status] ?? "Okänd";
}

// ---------------------------------------------------------------------------
// Validering (rena funktioner)
// ---------------------------------------------------------------------------

const FIELD_LABEL: Record<keyof AwishMemberInput, string> = {
  name: "namn",
  tel: "telefon",
  email: "e-post",
  memberNo: "medlemsnummer",
  machineId: "automat",
  levelId: "nivå",
  status: "status",
  remark: "anteckning",
};

function text(raw: unknown, max: number, label: string, pattern?: RegExp): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (t === "") return undefined;
  if (t.length > max) throw new CatalogError(`${label} får vara högst ${max} tecken.`);
  if (pattern && !pattern.test(t)) throw new CatalogError(`${label} ser inte rätt ut.`);
  return t;
}

function statusOf(raw: unknown): 0 | 1 | 2 | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  throw new CatalogError("Välj status.");
}

/** Formulärets värden → en ny medlem. Saldo och lösenord tas aldrig emot. */
export function parseNewMember(raw: unknown): AwishMemberInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 60, "Namnet");
  if (!name) throw new CatalogError("Skriv ett namn.");
  const out: AwishMemberInput = { name };
  const tel = text(r.tel, 20, "Telefonnumret", /^\+?[0-9][0-9 ()-]{4,19}$/);
  const email = text(r.email, 100, "E-postadressen", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const memberNo = text(r.memberNo, 40, "Medlemsnumret", /^[\p{L}\p{N}_-]+$/u);
  const remark = text(r.remark, 200, "Anteckningen");
  const status = statusOf(r.status);
  if (tel) out.tel = tel;
  if (email) out.email = email;
  if (memberNo) out.memberNo = memberNo;
  if (remark) out.remark = remark;
  if (status !== undefined) out.status = status;
  return out;
}

/**
 * Ändringen mot medlemmen som den är i Awish: bara namn, medlemsnummer, status och
 * anteckning, och bara de som skiljer sig.
 */
export function memberPatch(current: AwishMember, raw: unknown): AwishMemberPatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const patch: AwishMemberPatch = {};
  const name = text(r.name, 60, "Namnet");
  if (r.name !== undefined && !name) throw new CatalogError("Skriv ett namn.");
  const memberNo = text(r.memberNo, 40, "Medlemsnumret", /^[\p{L}\p{N}_-]+$/u);
  const remark = text(r.remark, 200, "Anteckningen");
  const status = statusOf(r.status);
  if (name !== undefined && name !== current.name) patch.name = name;
  if (memberNo !== undefined && memberNo !== current.memberNo) patch.memberNo = memberNo;
  if (r.remark !== undefined && (remark ?? "") !== (current.remark ?? ""))
    patch.remark = remark ?? "";
  if (status !== undefined && status !== current.status) patch.status = status;
  return patch;
}

/** Namnen på fälten (för loggen och förhandsvisningen), aldrig värdena. */
export function fieldNames(input: AwishMemberPatch): string[] {
  return (Object.keys(input) as (keyof AwishMemberInput)[])
    .filter((k) => input[k] !== undefined)
    .sort();
}

function fieldText(fields: readonly string[]): string {
  return fields.map((f) => FIELD_LABEL[f as keyof AwishMemberInput] ?? f).join(", ");
}

// ---------------------------------------------------------------------------
// Läsning (direkt från Awish, sparas aldrig)
// ---------------------------------------------------------------------------

export type MembersPage =
  | { status: "demo"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; page: AwishPage<AwishMember> };

export async function loadMembersFor(
  viewer: Viewer,
  pageNo: number,
  deps: CatalogDeps = {},
): Promise<MembersPage> {
  await requireOperator(viewer, MEMBERS_FORBIDDEN);
  if (await isDemoOrganization(dbOf(deps), viewer.organization.id)) {
    return { status: "demo", message: DEMO_MESSAGES.integrations };
  }
  const currentPage = Number.isInteger(pageNo) && pageNo >= 1 && pageNo <= 10_000 ? pageNo : 1;
  try {
    const page = await withReadClient(
      viewer,
      deps,
      ({ api }) => api.members({ currentPage, perPage: MEMBERS_PER_PAGE }),
      MEMBERS_FORBIDDEN,
    );
    return { status: "ok", page };
  } catch (error) {
    return { status: "error", message: readErrorMessage(error) };
  }
}

async function findMember(api: AwishControlApi, id: string): Promise<AwishMember | null> {
  for (let p = 1; p <= MAX_FIND_PAGES; p++) {
    const page = await api.members({ currentPage: p, perPage: MEMBERS_PER_PAGE });
    const hit = page.items.find((m) => m.id === id);
    if (hit) return hit;
    const last = page.lastPage ?? (page.hasMore === false ? p : null);
    if (page.items.length === 0 || (last !== null && p >= last)) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skrivningar
// ---------------------------------------------------------------------------

type MemberAction = "create" | "update" | "delete";

async function computeMember(viewer: Viewer, raw: unknown, deps: CatalogDeps) {
  const r = (raw ?? {}) as { action?: unknown; id?: unknown };
  const action = r.action as MemberAction;
  if (action === "create") {
    await requireOperator(viewer, MEMBERS_FORBIDDEN);
    await refuseDemo(dbOf(deps), viewer.organization.id);
    const input = parseNewMember(raw);
    const fields = fieldNames(input);
    const plan = {
      lines: [`Ny medlem ${input.name} (${fieldText(fields)}).`],
      warnings: ["Awish ger medlemmen sitt standardlösenord för köp."],
      blocking: null,
      confirm: null,
    };
    return { action, id: null, input, patch: null, fields, name: input.name, plan };
  }
  if (action !== "update" && action !== "delete") throw new CatalogError("Okänd ändring.");
  const id = awishIdOf(r.id, "Välj medlem.");
  const current = await withReadClient(
    viewer,
    deps,
    ({ api }) => findMember(api, id),
    MEMBERS_FORBIDDEN,
  );
  if (!current) throw new CatalogError("Medlemmen finns inte längre i Awish. Ladda om sidan.");
  if (action === "delete") {
    const plan = {
      lines: [`${current.name} tas bort i Awish.`],
      warnings: [],
      blocking: null,
      confirm: `Ta bort ${current.name}? Det går inte att ångra.`,
    };
    return { action, id, input: null, patch: null, fields: [], name: current.name, plan };
  }
  const patch = memberPatch(current, raw);
  const fields = fieldNames(patch);
  const plan = {
    lines: fields.length > 0 ? [`${current.name}: ${fieldText(fields)} ändras.`] : [],
    warnings: [],
    blocking: fields.length === 0 ? "Inget är ändrat." : null,
    confirm: null,
  };
  return { action, id, input: null, patch, fields, name: current.name, plan };
}

function extraOf(c: Awaited<ReturnType<typeof computeMember>>) {
  return { action: c.action, id: c.id, input: c.input, patch: c.patch };
}

export async function previewMemberFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const c = await computeMember(viewer, raw, deps);
  return catalogPreview(c.plan, extraOf(c));
}

export async function applyMemberFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const c = await computeMember(viewer, raw, deps);
  if (c.plan.blocking) throw new CatalogError(c.plan.blocking);
  if (catalogPreview(c.plan, extraOf(c)).fingerprint !== r.fingerprint)
    throw new CatalogError(STALE_MESSAGE);
  const run = deps.run ?? runControlAction;
  if (c.action === "create") {
    const input = c.input!;
    const result = await run(
      viewer,
      { kind: "member_create", idempotencyKey: key, auditRequest: { fields: c.fields } },
      (api) => api.batchCreateMembers([input]),
      deps,
    );
    return outcomeOf(result, "Klart! Medlemmen finns nu i Awish.");
  }
  const id = c.id!;
  if (c.action === "update") {
    const patch = c.patch!;
    const result = await run(
      viewer,
      {
        kind: "member_update",
        targetId: id,
        idempotencyKey: key,
        auditRequest: { id, fields: c.fields },
      },
      (api) => api.updateMember(id, patch),
      deps,
    );
    return outcomeOf(result, "Klart! Medlemmen är ändrad i Awish.");
  }
  const result = await run(
    viewer,
    { kind: "member_delete", targetId: id, idempotencyKey: key, auditRequest: { id } },
    (api) => api.deleteMember(id),
    deps,
  );
  return outcomeOf(result, "Klart! Medlemmen är borttagen i Awish.");
}
