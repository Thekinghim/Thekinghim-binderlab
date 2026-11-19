/**
 * Fel i de schemalagda stegen ska höras, inte bara skrivas i serverloggen (robusthet 1B,
 * punkt 7): avräkningsjobbet (job:avrakningar). Kampanjerna (job:kampanjer) provas i
 * kampanjer.test.ts mot låtsas-Awish.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { FailureCapture } from "@/server/monitoring";
import { recordSettlementRuns } from "@/server/monitoring/failures";

import { createOrg, createUser, db, rows, uniqueSuffix } from "./helpers";

const quiet: FailureCapture = async () => null;
const NOW = new Date("2026-12-01T05:17:00Z");

let orgId: string;
let otherOrg: string;

async function alerts(org: string) {
  return rows<{ status: string; severity: string; title: string; message: string; link: string }>(
    db(),
    sql`select status, severity::text, title, message, link from public.alerts
        where organization_id = ${org}::uuid and incident_key = 'job:avrakningar'
        order by triggered_at`,
  );
}

beforeAll(async () => {
  const owner = await createUser(`jobb-larm-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Jobblarm ${uniqueSuffix()}`);
  const other = await createUser(`jobb-larm-b-${uniqueSuffix()}@test.binderlab.se`);
  otherOrg = await createOrg(other, `Jobblarm B ${uniqueSuffix()}`);
});

describe("avräkningsjobbet", () => {
  it("en butik som inte går att räkna ger ett larm för just den organisationen", async () => {
    const r = await recordSettlementRuns({ db: db(), capture: quiet, now: NOW }, [
      {
        organizationId: orgId,
        errors: [
          { storeId: "s1", message: "Sega gubben: order utan inköpspris." },
          { storeId: "s2", message: "ICA Tuve: order utan inköpspris." },
        ],
      },
      { organizationId: otherOrg, errors: [] },
    ]);
    expect(r.failed).toBe(1);
    const found = await alerts(orgId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      status: "open",
      severity: "warning",
      title: "Jobbet för butikernas avräkningar misslyckades",
      link: "/butiker?vy=utbetalning",
    });
    expect(found[0]!.message).toBe(
      "Det schemalagda jobbet kunde inte köras för organisationen. Fel: 2 butiker kunde inte räknas. Sega gubben: order utan inköpspris. Månadens avräkningar har inte skapats eller räknats om. Öppna Butiker → Utbetalning och skapa dem där.",
    );
    expect(await alerts(otherOrg)).toEqual([]);
  });

  it("samma fel nästa dag ger inget nytt larm, och en ren körning stänger det", async () => {
    await recordSettlementRuns({ db: db(), capture: quiet, now: NOW }, [
      {
        organizationId: orgId,
        errors: [{ storeId: "s1", message: "Sega gubben: order utan inköpspris." }],
      },
    ]);
    expect((await alerts(orgId)).map((a) => a.status)).toEqual(["open"]);
    await recordSettlementRuns({ db: db(), capture: quiet, now: NOW }, [
      { organizationId: orgId, errors: [] },
    ]);
    expect((await alerts(orgId)).map((a) => a.status)).toEqual(["closed"]);
  });

  it("hela körningen föll för organisationen: kritiskt, med felet", async () => {
    await recordSettlementRuns({ db: db(), capture: quiet, now: NOW }, [
      { organizationId: otherOrg, errors: [{ storeId: "", message: "Databasfel: timeout" }] },
    ]);
    const [alert] = await alerts(otherOrg);
    expect(alert).toMatchObject({ status: "open", severity: "critical" });
    expect(alert!.message).toContain("Fel: Databasfel: timeout.");
  });
});
