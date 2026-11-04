/**
 * Rundresor till databasen (./round-trips.ts) för varje transaktion som användare (withRls,
 * alla laddare). Varje rundresa kostar tid i drift, där databasen inte står bredvid servern,
 * och en sidladdning kör många transaktioner:
 *
 * - withRls sätter claims (en parameter med känd typ) och roll i en sats: begin, en sats, commit (tre
 *   rundresor; förut fem: claims med parameter beskrevs först, och rollen var en egen sats),
 * - RLS gäller fortfarande: rollen är authenticated med rätt användare i transaktionen och
 *   nollställs efter, och claims med citattecken i e-posten fungerar.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getServiceDb, withRls } from "../../src/db/client";

import { createUser, one, type TestUser } from "./helpers";
import { installRoundTripCounter, type RoundTripCounter } from "./round-trips";

vi.mock("server-only", () => ({}));

let counter: RoundTripCounter;
let owner: TestUser;

beforeAll(async () => {
  owner = await createUser();
  counter = await installRoundTripCounter();
});

afterAll(async () => {
  await counter.restore();
});

const claims = () => ({ sub: owner.id, email: owner.email });

describe("rundresor", () => {
  it("withRls: begin, claims och roll i en sats, commit", async () => {
    await withRls(claims(), async () => null);
    counter.reset();
    await withRls(claims(), async () => null);
    expect(counter.count()).toBe(3);
  });

  it("RLS gäller i transaktionen och släpps efter", async () => {
    const inside = await withRls(claims(), (tx) =>
      one<{ who: string; uid: string }>(
        tx,
        sql`select current_user::text as who, auth.uid()::text as uid`,
      ),
    );
    expect(inside).toEqual({ who: "authenticated", uid: owner.id });
    const after = await one<{ who: string }>(getServiceDb(), sql`select current_user::text as who`);
    expect(after.who).not.toBe("authenticated");
  });

  it("claims med citattecken och dollartecken i e-posten", async () => {
    for (const email of [`o'hara-${owner.id.slice(0, 4)}@test.se`, "$bl_claims$@test.se"]) {
      const u = await createUser(email);
      const got = await withRls({ sub: u.id, email }, (tx) =>
        one<{ email: string; uid: string }>(
          tx,
          sql`select current_setting('request.jwt.claims', true)::jsonb ->> 'email' as email,
                     auth.uid()::text as uid`,
        ),
      );
      expect(got).toEqual({ email, uid: u.id });
    }
  });
});
