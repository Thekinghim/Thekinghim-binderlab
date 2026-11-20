/**
 * Databasanslutning för servern (Drizzle + postgres.js).
 *
 * Två ingångar:
 *
 * - `withRls(claims, fn)`: kör `fn` i en transaktion som den inloggade
 *   användaren: `set local role authenticated` och JWT-claims i
 *   `request.jwt.claims`, precis som Supabase/PostgREST. RLS gäller fullt ut.
 *   Det här är standardvägen för allt som görs på uppdrag av en användare.
 *
 * - `getServiceDb()`: anslutningen som databasägare. KRINGGÅR RLS. Får BARA
 *   användas i serverjobb och skript (schemalagd import, gallring, migrering,
 *   seed) där det inte finns någon användare, aldrig för att svara på en
 *   användares begäran. Triggers (organization_id, append-only, perioder)
 *   gäller fortfarande.
 *
 * Fungerar mot både lokal Postgres och Supabase (anslutning som postgres).
 * Mot Supabase-poolern i transaktionsläge (port 6543) stängs prepared
 * statements av automatiskt.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema> & { $client: Sql };
/** Transaktionen som `withRls` och `db.transaction` ger. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface RlsClaims {
  /** auth.users.id för den inloggade användaren. */
  sub: string;
  email?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DbCache {
  url: string;
  db: Db;
}

const globalForDb = globalThis as typeof globalThis & { __binderlabDb?: DbCache };

function isTransactionPooler(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === "6543" || u.searchParams.get("pgbouncer") === "true";
  } catch {
    return false;
  }
}

/**
 * Sekunder som en ledig anslutning hålls öppen. På Vercel fryses funktionen mellan anrop:
 * en anslutning som legat kvar sedan förra anropet kan vara död utan att processen vet
 * det, och nästa fråga på den blir hängande tills funktionen dödas. En ledig anslutning
 * stängs därför efter en kort stund (nästa fråga öppnar en ny).
 */
const IDLE_TIMEOUT_S = 20;
/** Sekunder att vänta på en ny anslutning innan det blir ett fel i stället för en väntan. */
const CONNECT_TIMEOUT_S = 10;

function createDb(url: string): Db {
  const client = postgres(url, {
    max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10) || 10,
    prepare: !isTransactionPooler(url),
    onnotice: () => {},
    idle_timeout: Number.parseInt(process.env.DATABASE_IDLE_TIMEOUT ?? "", 10) || IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { application_name: "binderlab", TimeZone: "UTC" },
  });
  return drizzle(client, { schema });
}

/**
 * Anslutning som databasägare (kringgår RLS). Endast för serverjobb och
 * skript, se filhuvudet. Återanvänds mellan anrop (och mellan HMR-laddningar
 * i utvecklingsläge).
 */
export function getServiceDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL saknas.");
  }
  const cached = globalForDb.__binderlabDb;
  if (cached && cached.url === url) {
    return cached.db;
  }
  const db = createDb(url);
  globalForDb.__binderlabDb = { url, db };
  return db;
}

/** Så länge får frågan "lever anslutningen?" ta innan anslutningen byts ut. */
export const DB_PING_TIMEOUT_MS = 5_000;

export interface FreshDbDeps<T> {
  /** Den delade anslutningen (skapas om den saknas). */
  readonly get: () => T;
  /** Släpper den delade anslutningen utan att vänta på frågor som hänger. */
  readonly drop: () => void;
  /** En enkel fråga. Ska kasta eller aldrig bli klar när anslutningen är död. */
  readonly ping: (db: T) => Promise<unknown>;
  readonly timeoutMs?: number;
}

async function answers<T>(deps: FreshDbDeps<T>, db: T): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deps.timeoutMs ?? DB_PING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      deps.ping(db).then(
        () => true as const,
        () => false as const,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * En anslutning som bevisligen svarar. Svarar den delade inte inom tidsgränsen (död efter
 * att funktionen legat fryst) släpps den och en ny öppnas. Kastar om inte heller den svarar:
 * då är databasen onåbar, och det ska bli ett fel på sekunder i stället för att jobbet
 * hänger tills det dödas utan spår.
 */
export async function freshDbWith<T>(deps: FreshDbDeps<T>): Promise<T> {
  const first = deps.get();
  if (await answers(deps, first)) return first;
  deps.drop();
  const second = deps.get();
  if (await answers(deps, second)) return second;
  throw new Error("Databasen svarar inte.");
}

/**
 * Systemrollens anslutning för ett schemalagt jobb, kontrollerad först (se freshDbWith).
 * Varje cron-route börjar här. Också getServiceDb() och withRls() får den nya anslutningen
 * efter ett byte, eftersom den delade pekar om.
 */
export function freshServiceDb(): Promise<Db> {
  return freshDbWith<Db>({
    get: getServiceDb,
    drop: () => {
      const cached = globalForDb.__binderlabDb;
      globalForDb.__binderlabDb = undefined;
      // Väntar inte: en fråga som hänger på en död anslutning blir aldrig klar.
      void cached?.db.$client.end({ timeout: 0 }).catch(() => {});
    },
    ping: (db) => db.execute(sql`select 1`),
  });
}

/** Stänger den delade anslutningen (för skript och tester). */
export async function closeServiceDb(): Promise<void> {
  const cached = globalForDb.__binderlabDb;
  globalForDb.__binderlabDb = undefined;
  if (cached) {
    await cached.db.$client.end();
  }
}

/** Typen text i Postgres (pg_type.oid). */
const TEXT_OID = 25;

/**
 * Claims och roll i EN sats (som "set local role authenticated"; båda gäller bara
 * transaktionen). Claims skickas som en parameter med känd typ (text): en parameter utan typ
 * beskrivs först av postgres.js (en rundresa till), och rollen var en egen sats. Fem
 * rundresor per transaktion blir tre (begin, den här, commit), och sidorna kör många.
 */
export function rlsSetup(client: Sql, jwt: string): SQL {
  const claims = client.typed(jwt, TEXT_OID);
  // idle_in_transaction_session_timeout: en transaktion vars funktion frysts eller avbrutits
  // (Vercel fryser funktionen när svaret är skickat) stängs av databasen efter 30 s i stället
  // för att hålla en av poolens få anslutningar tills funktionen dödas. Annars tar
  // anslutningarna slut och alla sidor hänger.
  return sql`select set_config('request.jwt.claims', ${claims}, true), set_config('role', 'authenticated', true), set_config('idle_in_transaction_session_timeout', '30s', true)`;
}

/**
 * Kör `fn` i en transaktion som användaren `claims.sub` med RLS påslaget.
 * Allt i `fn` måste gå via `tx`. Transaktionen rullas tillbaka om `fn` kastar.
 */
export async function withRls<T>(claims: RlsClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(claims.sub)) {
    throw new TypeError("withRls: sub måste vara ett uuid.");
  }
  const jwt = JSON.stringify({
    sub: claims.sub,
    email: claims.email,
    role: "authenticated",
    aud: "authenticated",
  });
  const db = getServiceDb();
  return db.transaction(async (tx) => {
    await tx.execute(rlsSetup(db.$client, jwt));
    return fn(tx);
  });
}
