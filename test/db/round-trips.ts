/**
 * Räknar rundresor till databasen: hur många gånger klienten skickar något efter att ha fått
 * svar. Frågor som skickas samtidigt (Promise.all i en transaktion, postgres.js pipelinar dem)
 * blir en rundresa; frågor som väntar på varandra blir en var. I drift kostar varje rundresa
 * tid (databasen står inte bredvid servern), så laddarna ska ha så få som möjligt.
 *
 *   const counter = await installRoundTripCounter();
 *   counter.reset(); await withRls(...); counter.count();
 *   await counter.restore();
 *
 * Byter den delade anslutningen (getServiceDb) mot en med räknande socket, med max 1
 * anslutning så att allt går över samma socket.
 */

import net from "node:net";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServiceDb, type Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";

type DbCache = { url: string; db: Db };
const globalForDb = globalThis as typeof globalThis & { __binderlabDb?: DbCache };

export interface RoundTripCounter {
  /** Rundresor sedan reset(). */
  count(): number;
  reset(): void;
  restore(): Promise<void>;
}

export async function installRoundTripCounter(): Promise<RoundTripCounter> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL saknas.");
  getServiceDb();
  const previous = globalForDb.__binderlabDb;
  let trips = 0;
  let answered = true;
  const client = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "binderlab-rundresor", TimeZone: "UTC" },
    socket: ({ host, port }: { host: string[]; port: number[] }) => {
      const socket = net.connect(port[0] ?? 5432, host[0] ?? "127.0.0.1");
      const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
      (socket as unknown as { write: (...args: unknown[]) => boolean }).write = (...args) => {
        if (answered) {
          trips += 1;
          answered = false;
        }
        return write(...args);
      };
      socket.prependListener("data", () => {
        answered = true;
      });
      return socket;
    },
  } as postgres.Options<Record<string, postgres.PostgresType>>);
  const db = drizzle(client, { schema }) as unknown as Db;
  // Anslut och värm upp (typer, inloggning) innan något räknas.
  await db.execute(sql`select 1`);
  globalForDb.__binderlabDb = { url, db };
  return {
    count: () => trips,
    reset: () => {
      trips = 0;
      answered = true;
    },
    restore: async () => {
      globalForDb.__binderlabDb = previous;
      await client.end();
    },
  };
}
