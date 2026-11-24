/**
 * Skickar Binderlabs maskinlager till Awishs webbpanel efter en påfyllning, så ägaren
 * aldrig behöver skriva antal på dash.awish.vip. Allt på servern; butikens inloggning
 * läses krypterat ur Vault (private.awish_read_web_credentials) och lämnar aldrig servern.
 *
 * En push rör bara automater som just fyllts på, höjer bara fackens antal (aldrig sänker),
 * och den blockerar aldrig att påfyllningen sparas: misslyckas den rapporteras det, men
 * påfyllningen ligger redan kvar i Binderlab.
 */

import { getServiceDb, type Db } from "@/db/client";
import { sql } from "drizzle-orm";

import {
  logAwishPushOutcomes,
  logAwishPushes,
  markAwishPushesPending,
  pendingAwishPushes,
} from "@/server/varde/log";

import { AwishApiError, type AwishErrorKind } from "./grpc-client";
import { breakerOpen, openBreaker, recordPathResult } from "./health";
import {
  createAwishWebClient,
  type AwishWebApi,
  type AwishWebLogin,
  type AwishWebClientOptions,
} from "./web-client";
import { planAwishPush, type MachineTitleQuantity, type NotSent } from "./web-push";

// ---------------------------------------------------------------------------
// Nytt försök vid skrivningar (Om Awish krånglar)
// ---------------------------------------------------------------------------

/** Väntan före försök 2, 3 och 4 för en skrivning som tål att göras om. */
export const WRITE_RETRY_WAITS_MS: readonly number[] = [500, 1_500, 4_000];
/** Ett nytt försök påbörjas bara om minst så här lång tid finns kvar till deadline. */
export const WRITE_RETRY_MIN_CALL_MS = 1_000;
/** Tidsgräns för en sändning som en användare väntar på (Fyll på, Klar). */
export const INTERACTIVE_WRITE_BUDGET_MS = 25_000;
/** Extra tid per automat utöver den första, och högsta tiden för en sändning. */
export const INTERACTIVE_WRITE_PER_MACHINE_MS = 5_000;
export const INTERACTIVE_WRITE_MAX_MS = 45_000;
/** Automatiska nya försök tar bara sändningar som felade för högst så här länge sedan. */
export const AUTO_RETRY_MAX_AGE_MS = 24 * 3_600_000;

/** Tiden för en sändning med `machines` automater: 25 s + 5 s per extra automat, högst 45 s. */
export function interactivePushBudgetMs(machines: number): number {
  return Math.min(
    INTERACTIVE_WRITE_MAX_MS,
    INTERACTIVE_WRITE_BUDGET_MS + Math.max(0, machines - 1) * INTERACTIVE_WRITE_PER_MACHINE_MS,
  );
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WriteRetryOptions {
  /**
   * Tål skrivningen att göras om? UpdateProduct (absolut antal) och UpdateGood (hela varan)
   * gör det; CreateGood gör det inte (då kan varan skapas två gånger).
   */
  readonly idempotent: boolean;
  /** Ingen ny början efter den här tiden (ms sedan 1970). */
  readonly deadlineAt?: number;
  /** Väntetider mellan försöken; standard WRITE_RETRY_WAITS_MS. */
  readonly waits?: readonly number[];
  readonly now?: () => number;
  readonly sleep?: Sleep;
}

/**
 * Fel där ett nytt försök kan hjälpa: Awish svarar inte (5xx, nätverk) eller svarade inte i
 * tid. Aldrig auth (kontot kan spärras av upprepade inloggningar), rate_limited (429: fler
 * anrop gör det värre), changed (koden måste ändras) eller server (Awish sa nej).
 */
export function isRetryableAwishError(error: unknown): boolean {
  return (
    error instanceof AwishApiError && (error.kind === "unavailable" || error.kind === "timeout")
  );
}

/**
 * Kör `op` och försöker igen vid tillfälliga fel, med väntan 0,5, 1,5 och 4 s, så länge det
 * finns tid kvar till `deadlineAt`. Bara för skrivningar som tål att göras om (`idempotent`);
 * annars körs `op` en gång. Kastar det sista felet.
 */
export async function withWriteRetry<T>(op: () => Promise<T>, opts: WriteRetryOptions): Promise<T> {
  const waits = opts.idempotent ? (opts.waits ?? WRITE_RETRY_WAITS_MS) : [];
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      const wait = waits[attempt];
      if (wait === undefined || !isRetryableAwishError(error)) throw error;
      if (opts.deadlineAt != null && now() + wait + WRITE_RETRY_MIN_CALL_MS > opts.deadlineAt) {
        throw error;
      }
      await sleep(wait);
    }
  }
}

/** En rads resultat för en automat. */
export interface MachinePushResult {
  machineId: string;
  machineCode: string | null;
  status: "pushed" | "nothing" | "no_awish_machine" | "error";
  /** Antal fack som ändrades i Awish. */
  slotsUpdated: number;
  /** Titlar i Binderlab som saknar fack i Awish (rapporteras, inte ett fel). */
  titlesWithoutSlot: string[];
  /**
   * Pack som Awish inte tog emot (facket rymmer inte fler, eller mystery-facket är inte
   * tomt). Automaten räknas då som väntande, så att saldot inte sänks till Awishs antal.
   */
  notSent?: NotSent[];
  /** Provkörning: vad som skulle ändras (titel, fack, från → till). Tom vid riktig push. */
  planned?: Array<{ titleName: string; productId: number; from: number; to: number }>;
  /** Provkörning: antal fack Awish visade för automaten. */
  slotsRead?: number;
  error?: string;
  /** Feltypen när status är "error" (auth, unavailable, timeout, budget …). */
  errorKind?: AwishErrorKind;
}

export interface WebPushResult {
  /** "off" = push avstängd eller ingen inloggning; "done" = körd (se machines). */
  status: "off" | "done";
  reason?: "no_credentials" | "disabled" | "no_source";
  machines: MachinePushResult[];
}

export interface WebPushDeps {
  serviceDb?: Db;
  /** Klienten mot Awish; injiceras i tester (annars riktiga webb-klienten). */
  makeClient?: (options: AwishWebClientOptions) => AwishWebApi;
  clientOptions?: AwishWebClientOptions;
  /** Provkörning: logga in och läs, men skriv ingenting till Awish (gäller även när push är av). */
  dryRun?: boolean;
  /**
   * Ta även med automaterna som väntar sedan en tidigare sändning inte gick fram (nytt
   * försök i samma körning). Används när en påfyllning sparas.
   */
  withPending?: boolean;
  /**
   * Ingen ny automat eller nytt försök påbörjas efter den här tiden (ms sedan 1970). Standard
   * INTERACTIVE_WRITE_BUDGET_MS från anropet. Automater som inte hanns med väntar och tas
   * igen av den automatiska körningen.
   */
  deadlineAt?: number;
  /** Klocka i ms; injiceras i tester. */
  nowMs?: () => number;
  /** Väntan mellan försöken; injiceras i tester. */
  sleep?: Sleep;
  /**
   * Sändningen för "Försök igen" och de automatiska försöken. Standard pushMachinesToAwish
   * (webbpanelen); anroparna skickar pushRefillToAwish (control/refill-push.ts), som går via
   * API:t när organisationen har valt det under Datakällor och annars är exakt webbvägen.
   */
  push?: (
    organizationId: string,
    machineIds: readonly string[],
    deps: WebPushDeps,
  ) => Promise<WebPushResult>;
}

interface WebSource {
  id: string;
  organization_id: string;
  enabled: boolean;
}

type WebCredentials = AwishWebLogin;

export async function loadWebSource(db: Db, organizationId: string): Promise<WebSource | null> {
  const rows = Array.from(
    await db.execute(sql`
      select ds.id, ds.organization_id,
             coalesce((ds.config -> 'awishWeb' ->> 'enabled')::boolean, false) as enabled
      from public.data_sources ds
      where ds.organization_id = ${organizationId}::uuid
        and ds.provider = 'awish_grpc' and ds.archived_at is null
      order by ds.created_at asc
      limit 1`),
  ) as Array<{ id: string; organization_id: string; enabled: boolean }>;
  return rows[0] ?? null;
}

export async function readWebCredentials(
  db: Db,
  dataSourceId: string,
): Promise<WebCredentials | null> {
  const rows = Array.from(
    await db.execute(
      sql`select private.awish_read_web_credentials(${dataSourceId}::uuid) as creds`,
    ),
  ) as Array<{ creds: unknown }>;
  const c = (rows[0]?.creds ?? null) as Record<string, unknown> | null;
  if (!c || typeof c.email !== "string" || typeof c.password !== "string") return null;
  return { email: c.email, password: c.password };
}

/** Awishs maskin-id (source_machines.external_id) för en Binderlab-automat. */
export async function awishMachineId(
  db: Db,
  organizationId: string,
  dataSourceId: string,
  machineId: string,
): Promise<number | null> {
  const rows = Array.from(
    await db.execute(sql`
      select sm.external_id
      from public.source_machines sm
      where sm.organization_id = ${organizationId}::uuid
        and sm.data_source_id = ${dataSourceId}::uuid
        and sm.machine_id = ${machineId}::uuid
        and sm.external_id ~ '^[0-9]{1,30}$'
      limit 1`),
  ) as Array<{ external_id: string }>;
  const raw = rows[0]?.external_id;
  return raw ? Number(raw) : null;
}

/** Binderlabs antal per titel i automaten nu (bara titlar med räknat saldo). */
async function machineTitleStock(
  db: Db,
  organizationId: string,
  machineId: string,
): Promise<MachineTitleQuantity[]> {
  const rows = Array.from(
    await db.execute(sql`
      select t.name as title_name, l.quantity,
             -- Mystery pack (egen produkt med innehåll): fylls bara i tomma fack.
             (t.own_product and exists (
                select 1 from public.mystery_recipes r
                where r.organization_id = t.organization_id and r.title_id = t.id)) as mystery
      from public.stock_locations loc
      join public.stock_levels l
        on l.organization_id = loc.organization_id and l.location_id = loc.id
      join public.titles t on t.organization_id = l.organization_id and t.id = l.title_id
      where loc.organization_id = ${organizationId}::uuid
        and loc.machine_id = ${machineId}::uuid
        and loc.kind = 'machine'
        and l.last_counted_at is not null
        and t.archived_at is null`),
  ) as Array<{ title_name: string; quantity: number; mystery: boolean | null }>;
  return rows.map((r) => ({
    titleName: r.title_name,
    quantity: Number(r.quantity),
    ...(r.mystery === true ? { mystery: true } : {}),
  }));
}

/** Automatens kod (BL-001) för loggning. */
async function machineCodes(
  db: Db,
  organizationId: string,
  machineIds: string[],
): Promise<Map<string, string | null>> {
  if (machineIds.length === 0) return new Map();
  const rows = Array.from(
    await db.execute(sql`
      select m.id::text as id, m.code
      from public.machines m
      where m.organization_id = ${organizationId}::uuid
        and m.id in (select jsonb_array_elements_text(${JSON.stringify(machineIds)}::jsonb)::uuid)`),
  ) as Array<{ id: string; code: string | null }>;
  return new Map(rows.map((r) => [r.id, r.code]));
}

/**
 * Skickar en eller flera automaters lager till Awish. `organizationId` och `machineIds`
 * kommer från en redan rollkontrollerad åtgärd (påfyllningen). Loggar aldrig lösenordet.
 */
/** Alla Binderlab-automater som är kopplade till organisationens Awish-källa. */
export async function linkedAwishMachineIds(
  organizationId: string,
  deps: WebPushDeps = {},
): Promise<string[]> {
  const db = deps.serviceDb ?? getServiceDb();
  const rows = Array.from(
    await db.execute(sql`
      select distinct sm.machine_id::text as id
      from public.source_machines sm
      join public.data_sources ds on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
      where sm.organization_id = ${organizationId}::uuid
        and ds.provider = 'awish_grpc' and ds.archived_at is null
        and sm.machine_id is not null`),
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export async function pushMachinesToAwish(
  organizationId: string,
  machineIds: readonly string[],
  deps: WebPushDeps = {},
): Promise<WebPushResult> {
  const db = deps.serviceDb ?? getServiceDb();
  const ids = [...new Set(machineIds)].filter(Boolean);
  if (deps.withPending && !deps.dryRun) {
    // Automater som väntar sedan förra felet följer med: ett nytt försök utan ett tryck.
    try {
      for (const id of (await pendingAwishPushes(db, organizationId)).keys()) {
        if (!ids.includes(id)) ids.push(id);
      }
    } catch (error) {
      console.error("Kunde inte läsa väntande Awish-sändningar.", error);
    }
  }
  if (ids.length === 0) return { status: "off", reason: "no_source", machines: [] };

  const source = await loadWebSource(db, organizationId);
  if (!source) return { status: "off", reason: "no_source", machines: [] };
  if (!source.enabled && !deps.dryRun) return { status: "off", reason: "disabled", machines: [] };

  const creds = await readWebCredentials(db, source.id);
  if (!creds) return { status: "off", reason: "no_credentials", machines: [] };

  const codes = await machineCodes(db, organizationId, ids);
  const nowMs = deps.nowMs ?? (() => Date.now());
  const deadlineAt = deps.deadlineAt ?? nowMs() + interactivePushBudgetMs(ids.length);
  // Klientens egen tidsgräns: inget enskilt anrop (inloggning, läsning) får gå förbi
  // sändningens tid, så att funktionen aldrig stoppas av plattformen mitt i.
  const client = (deps.makeClient ?? createAwishWebClient)({
    ...(deps.clientOptions ?? {}),
    deadlineAt: Math.min(deps.clientOptions?.deadlineAt ?? Infinity, deadlineAt),
  });
  const machines: MachinePushResult[] = [];
  let loggedIn = false;
  let firstError: unknown = null;
  const retry = { deadlineAt, now: nowMs, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  if (!deps.dryRun) {
    // Väntande FÖRE sändningen: stoppas funktionen mitt i (tidsgräns hos plattformen) står
    // automaterna kvar som väntande, så att påfyllningen inte försvinner och nästa läsning
    // av facken inte sänker saldot. Raderna stängs nedan när sändningen gick fram.
    await markAwishPushesPending(db, organizationId, ids);
  }

  for (const machineId of ids) {
    const code = codes.get(machineId) ?? null;
    // Tiden är slut: resten väntar och tas igen automatiskt (aldrig halvvägs i en automat).
    if (nowMs() + WRITE_RETRY_MIN_CALL_MS > deadlineAt) {
      machines.push({
        machineId,
        machineCode: code,
        status: "error",
        slotsUpdated: 0,
        titlesWithoutSlot: [],
        error: "Tiden tog slut. Appen försöker igen själv.",
        errorKind: "budget",
      });
      continue;
    }
    try {
      const awishId = await awishMachineId(db, organizationId, source.id, machineId);
      if (awishId == null) {
        machines.push({
          machineId,
          machineCode: code,
          status: "no_awish_machine",
          slotsUpdated: 0,
          titlesWithoutSlot: [],
        });
        continue;
      }
      const want = await machineTitleStock(db, organizationId, machineId);
      if (!loggedIn) {
        // Klienten provar inloggningen igen vid 503/tidsgräns (inom tiden), aldrig vid nekad
        // inloggning eller 429. Inget eget nytt försök här: då blir det för många inloggningar.
        await client.login(creds);
        loggedIn = true;
      }
      const products = await client.products(awishId);
      const plan = planAwishPush(want, products);
      if (deps.dryRun) {
        machines.push({
          machineId,
          machineCode: code,
          status: "nothing",
          slotsUpdated: 0,
          titlesWithoutSlot: plan.titlesWithoutSlot,
          slotsRead: products.length,
          planned: plan.updates.map((u) => ({
            titleName: u.titleName,
            productId: u.productId,
            from: u.previousInventory,
            to: u.currentInventory,
          })),
        });
        continue;
      }
      for (const u of plan.updates) {
        // Absolut antal: samma anrop två gånger ger samma fack. Men ett försök som ändå gick
        // fram, följt av ett köp, får inte lägga tillbaka det sålda packet: före ett nytt
        // försök läses facken om, och har facket ändrats sedan planen skickas inget igen.
        let retrying = false;
        await withWriteRetry(
          async () => {
            if (retrying) {
              const slot = (await client.products(awishId)).find((p) => p.id === u.productId);
              if (!slot || slot.currentInventory !== u.previousInventory) return;
            }
            retrying = true;
            await client.setProductInventory(u.productId, {
              goodId: u.goodId,
              status: u.status,
              currentInventory: u.currentInventory,
            });
          },
          { idempotent: true, ...retry },
        );
      }
      machines.push({
        machineId,
        machineCode: code,
        status: plan.updates.length > 0 ? "pushed" : "nothing",
        slotsUpdated: plan.updates.length,
        titlesWithoutSlot: plan.titlesWithoutSlot,
        ...(plan.notSent.length > 0 ? { notSent: plan.notSent } : {}),
      });
    } catch (error) {
      firstError ??= error;
      const message =
        error instanceof AwishApiError
          ? error.message
          : "Kunde inte skicka till Awish. Försök igen.";
      const errorKind: AwishErrorKind = error instanceof AwishApiError ? error.kind : "server";
      machines.push({
        machineId,
        machineCode: code,
        status: "error",
        slotsUpdated: 0,
        titlesWithoutSlot: [],
        error: message,
        errorKind,
      });
      // Ett auth-fel gäller hela inloggningen: sluta försöka med fler automater. De som
      // inte hanns med får samma fel, så att de också sparas som väntande.
      if (error instanceof AwishApiError && error.kind === "auth") {
        const done = new Set(machines.map((m) => m.machineId));
        for (const rest of ids) {
          if (done.has(rest)) continue;
          machines.push({
            machineId: rest,
            machineCode: codes.get(rest) ?? null,
            status: "error",
            slotsUpdated: 0,
            titlesWithoutSlot: [],
            error: message,
            errorKind,
          });
        }
        break;
      }
    }
  }

  if (!deps.dryRun) {
    // Värde: räknas som sparad tid (automation_log). Stoppar aldrig pushen.
    await logAwishPushes(db, organizationId, machines);
    // Utfallet per automat: de som inte gick fram väntar och försöks igen (Fyll på). En
    // automat där Awish inte tog emot allt väntar också: annars sänker nästa läsning av
    // facken saldot till Awishs lägre antal, och packen finns då varken i vårt lager eller
    // i automaten.
    await logAwishPushOutcomes(
      db,
      organizationId,
      machines.map((m) => ((m.notSent?.length ?? 0) > 0 ? { ...m, status: "error" } : m)),
    );
    // Hälsan för vägen "push" (Datakällor, vakten). Bara när Awish faktiskt kontaktades.
    if (loggedIn || firstError !== null) {
      await recordPushHealth(db, organizationId, source.id, machines, firstError);
    }
  }
  return { status: "done", machines };
}

/**
 * Sparar utfallet för vägen "push" och, vid nekad inloggning, öppnar brytaren (6 h) så att
 * den automatiska körningen inte loggar in om och om igen och spärrar Awish-kontot. Kastar
 * aldrig.
 */
async function recordPushHealth(
  db: Db,
  organizationId: string,
  dataSourceId: string,
  machines: readonly MachinePushResult[],
  firstError: unknown,
): Promise<void> {
  const failed = machines.filter((m) => m.status === "error");
  const authError =
    firstError instanceof AwishApiError && firstError.kind === "auth"
      ? firstError
      : failed.some((m) => m.errorKind === "auth")
        ? new AwishApiError("auth", "Awish nekade inloggningen.")
        : null;
  const rateLimited = failed.some((m) => m.errorKind === "rate_limited");
  const budgetOnly = failed.length > 0 && failed.every((m) => m.errorKind === "budget");
  try {
    await recordPathResult(db, {
      organizationId,
      dataSourceId,
      path: "push",
      // Inget nådde fram: påfyllningarna väntar i Binderlab tills webbpanelen svarar.
      route: failed.length === 0 ? "webbpanelen" : "ingen",
      ok: failed.length === 0,
      ...(failed.length > 0
        ? {
            error:
              authError ??
              (firstError instanceof AwishApiError
                ? firstError
                : budgetOnly
                  ? new AwishApiError("budget", "Tiden tog slut.")
                  : new AwishApiError("server", failed[0]?.error ?? "Okänt fel.")),
          }
        : {}),
    });
    if (authError) {
      await openBreaker(db, dataSourceId, "push", "webbpanelen", "auth");
    } else if (rateLimited) {
      // 429: inga automatiska försök på 5 minuter (fler anrop gör det värre).
      await openBreaker(db, dataSourceId, "push", "webbpanelen", "rate_limited");
    }
  } catch (error) {
    console.error(
      "[awish-push] hälsan kunde inte sparas",
      error instanceof Error ? error.name : "fel",
    );
  }
}

/**
 * Sändningen kunde inte ens påbörjas (ett oväntat fel före eller under pushMachinesToAwish):
 * automaterna sparas som väntande, så att felet syns i Fyll på och försöks igen.
 */
export async function recordAwishPushFailure(
  organizationId: string,
  machineIds: readonly string[],
  deps: Pick<WebPushDeps, "serviceDb"> = {},
): Promise<void> {
  const db = deps.serviceDb ?? getServiceDb();
  await logAwishPushOutcomes(
    db,
    organizationId,
    [...new Set(machineIds)].filter(Boolean).map((machineId) => ({
      machineId,
      status: "error",
      slotsUpdated: 0,
    })),
  );
}

export interface AwishRetryResult {
  /** Resultatet av försöket; null när ingen automat väntade. */
  readonly push: WebPushResult | null;
  /** Automater som fortfarande väntar efter försöket. */
  readonly pending: string[];
}

/**
 * "Försök igen": skickar de väntande automaternas antal till Awish en gång till.
 * `machineIds` null = alla som väntar i organisationen. Är push avstängd, eller saknas
 * inloggningen, finns inget att skicka: automaterna slutar vänta (läsningen av facken gäller
 * då igen). `organizationId` kommer från en redan rollkontrollerad åtgärd.
 */
export async function retryPendingAwishPushes(
  organizationId: string,
  machineIds: readonly string[] | null,
  deps: WebPushDeps = {},
): Promise<AwishRetryResult> {
  const db = deps.serviceDb ?? getServiceDb();
  const waiting = [...(await pendingAwishPushes(db, organizationId)).keys()];
  const ids = machineIds ? waiting.filter((id) => machineIds.includes(id)) : waiting;
  if (ids.length === 0) return { push: null, pending: waiting };
  const send = deps.push ?? pushMachinesToAwish;
  const push = await send(organizationId, ids, { ...deps, withPending: false });
  if (push.status === "off") {
    await logAwishPushOutcomes(
      db,
      organizationId,
      ids.map((machineId) => ({ machineId, status: "nothing", slotsUpdated: 0 })),
    );
  }
  return { push, pending: [...(await pendingAwishPushes(db, organizationId)).keys()] };
}

// ---------------------------------------------------------------------------
// Automatiskt nytt försök för alla organisationer (cron var femte minut)
// ---------------------------------------------------------------------------

/**
 * Väntan (minuter) före automatiskt försök 1, 2, 3, 4 och sedan varje: 5, 10, 20, 40, 60.
 * Räknas från den äldsta väntande sändningen, och sedan från förra automatiska försöket.
 */
export const PUSH_RETRY_BACKOFF_MIN: readonly number[] = [5, 10, 20, 40, 60];

/** När nästa automatiska försök får göras (väntetiden räknad från försök eller fel). */
export function nextPushRetryAt(
  oldestPending: Date,
  attempts: number,
  lastAttemptAt: Date | null,
): Date {
  const wait = PUSH_RETRY_BACKOFF_MIN[Math.min(attempts, PUSH_RETRY_BACKOFF_MIN.length - 1)] ?? 60;
  const from = attempts > 0 && lastAttemptAt ? lastAttemptAt : oldestPending;
  return new Date(from.getTime() + wait * 60_000);
}

export interface PushRetryAllOptions extends Pick<
  WebPushDeps,
  "makeClient" | "clientOptions" | "sleep" | "nowMs" | "push"
> {
  /** Ingen ny organisation påbörjas efter den här tiden (ms sedan 1970). */
  readonly deadline: number;
  /** Klocka för väntetiden; injiceras i tester. */
  readonly now?: () => Date;
  /** Bara de här organisationerna (tester); utelämnat = alla. */
  readonly organizationIds?: readonly string[];
}

export interface PushRetryAllResult {
  /** Organisationer med väntande sändningar. */
  readonly organizations: number;
  /** Organisationer där ett försök gjordes nu. */
  readonly tried: number;
  /** Av dem: inget väntar längre. */
  readonly cleared: number;
  /** Väntar på sin tur (väntetiden har inte gått). */
  readonly waiting: number;
  /** Hoppades över: brytaren är öppen (t.ex. nekad inloggning, 6 h). */
  readonly breaker: number;
  /** Hanns inte med i den här körningen. */
  readonly budget: number;
  /** Oväntade fel (loggade). */
  readonly errors: number;
}

const tsOf = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v));

/**
 * Försöker igen med väntande sändningar till Awish i alla organisationer, med väntetid per
 * organisation (PUSH_RETRY_BACKOFF_MIN). Påfyllningen är redan sparad i Binderlab; det här
 * ser bara till att Awish till slut får antalen utan att någon trycker "Försök igen".
 *
 * - Demo-organisationer och arkiverade hoppas över.
 * - En öppen brytare för "push" (nekad inloggning: 6 h) hoppar över organisationen, så att
 *   kontot inte spärras av upprepade inloggningar.
 * - Varje försök loggas som 'awish_push_retry' (för väntetiden) och i hälsan.
 * - Kastar aldrig.
 */
export async function retryPendingAwishPushesForAll(
  db: Db,
  opts: PushRetryAllOptions,
): Promise<PushRetryAllResult> {
  const out = {
    organizations: 0,
    tried: 0,
    cleared: 0,
    waiting: 0,
    breaker: 0,
    budget: 0,
    errors: 0,
  };
  const nowMs = opts.nowMs ?? (() => Date.now());
  const now = opts.now ?? (() => new Date(nowMs()));
  let orgs: Array<{
    organization_id: string;
    oldest: unknown;
    machines: number;
    machine_ids: string[];
  }>;
  // Bara sändningar som felade det senaste dygnet: äldre väntar på "Försök igen" i Fyll på
  // (Binderlabs antal kan vara inaktuellt, och en gammal sändning ska inte skriva över Awish).
  const since = new Date(now().getTime() - AUTO_RETRY_MAX_AGE_MS).toISOString();
  try {
    orgs = Array.from(
      await db.execute(sql`
        select x.organization_id::text as organization_id, min(x.occurred_at) as oldest,
               count(*)::int as machines,
               array_agg(x.machine_id::text order by x.occurred_at) as machine_ids
        from (
          select distinct on (a.organization_id, a.machine_id)
                 a.organization_id, a.machine_id, a.kind, a.occurred_at
          from public.automation_log a
          where a.machine_id is not null
            and a.kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared')
          order by a.organization_id, a.machine_id, a.occurred_at desc, a.created_at desc, a.id desc
        ) x
        join public.organizations o on o.id = x.organization_id
        where x.kind = 'awish_push_failed' and o.archived_at is null and not o.is_demo
          and x.occurred_at > ${since}::timestamptz
        group by x.organization_id
        order by min(x.occurred_at)`),
    ) as typeof orgs;
  } catch (error) {
    console.error(
      "[awish-push] väntande sändningar kunde inte läsas",
      error instanceof Error ? error.name : "fel",
    );
    return { ...out, errors: 1 };
  }
  if (opts.organizationIds) {
    const only = new Set(opts.organizationIds);
    orgs = orgs.filter((o) => only.has(o.organization_id));
  }
  out.organizations = orgs.length;

  for (const org of orgs) {
    if (nowMs() + WRITE_RETRY_MIN_CALL_MS * 5 > opts.deadline) {
      out.budget += 1;
      continue;
    }
    const orgId = org.organization_id;
    try {
      const oldest = tsOf(org.oldest) ?? now();
      const [prev] = Array.from(
        await db.execute(sql`
          select count(*)::int as attempts, max(a.occurred_at) as last_at
          from public.automation_log a
          where a.organization_id = ${orgId}::uuid and a.kind = 'awish_push_retry'
            and a.occurred_at >= ${oldest.toISOString()}::timestamptz`),
      ) as Array<{ attempts: number; last_at: unknown }>;
      const due = nextPushRetryAt(oldest, Number(prev?.attempts ?? 0), tsOf(prev?.last_at));
      if (now().getTime() < due.getTime()) {
        out.waiting += 1;
        continue;
      }
      const source = await loadWebSource(db, orgId);
      if (source && (await breakerOpen(db, source.id, "push", "webbpanelen", now()))) {
        out.breaker += 1;
        continue;
      }
      // Försöket räknas innan det görs: ett avbrott mitt i ger ändå längre väntan nästa gång.
      await db.execute(
        sql`insert into public.automation_log (organization_id, kind, machine_id, units, occurred_at)
            values (${orgId}::uuid, 'awish_push_retry', null, ${Math.min(org.machines, 10_000)},
                    ${now().toISOString()}::timestamptz)`,
      );
      out.tried += 1;
      const r = await retryPendingAwishPushes(orgId, org.machine_ids ?? [], {
        serviceDb: db,
        ...(opts.makeClient ? { makeClient: opts.makeClient } : {}),
        ...(opts.clientOptions ? { clientOptions: opts.clientOptions } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
        ...(opts.push ? { push: opts.push } : {}),
        deadlineAt: opts.deadline,
      });
      if (r.pending.length === 0) out.cleared += 1;
    } catch (error) {
      out.errors += 1;
      console.error(
        "[awish-push] automatiskt försök misslyckades",
        error instanceof AwishApiError ? error.kind : error instanceof Error ? error.name : "fel",
      );
    }
  }
  return out;
}
