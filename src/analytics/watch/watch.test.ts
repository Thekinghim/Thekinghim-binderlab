import { describe, expect, it } from "vitest";

import {
  ageText,
  alertRunLine,
  machineAges,
  machineAgeSummary,
  memberReached,
  reachedCount,
  reachLine,
  selfCheckLine,
  syncBroken,
  syncLine,
  watchLines,
  type ChannelsWorking,
  type ReachMember,
  type SyncSourceFacts,
} from "./index";

const NOW = new Date("2026-11-19T12:00:00Z");
const when = (iso: string) => `<${iso.slice(0, 16)}>`;
const ALL: ChannelsWorking = { email: true, push: true, sms: true };
const NO_MAIL: ChannelsWorking = { email: false, push: true, sms: false };

const member = (over: Partial<ReachMember> = {}): ReachMember => ({
  active: true,
  channels: ["email"],
  hasEmail: true,
  hasPhone: false,
  devices: 0,
  ...over,
});

describe("vem nås av ett larm", () => {
  it("e-post når fram bara när e-post kan skickas", () => {
    expect(memberReached(member(), ALL)).toBe(true);
    expect(memberReached(member(), NO_MAIL)).toBe(false);
  });

  it("push kräver en enhet som inte är avstängd", () => {
    expect(memberReached(member({ channels: ["push"] }), ALL)).toBe(false);
    expect(memberReached(member({ channels: ["push"], devices: 1 }), NO_MAIL)).toBe(true);
  });

  it("den som har stängt av sina larm nås inte", () => {
    expect(memberReached(member({ active: false, devices: 2, channels: ["push"] }), ALL)).toBe(
      false,
    );
  });

  it("produktionens läge: två ägare, ingen e-post, inga enheter → ingen får larm", () => {
    const facts = { members: [member(), member()], works: NO_MAIL };
    expect(reachedCount(facts)).toBe(0);
    const line = reachLine(facts);
    expect(line?.title).toBe("Ingen får larm just nu");
    expect(line?.detail).toBe(
      "Larmen syns bara här i appen. Slå på notiser på din telefon, så får du dem direkt.",
    );
    expect(line?.href).toBe("/drift/larm");
    expect(line?.action).toBe("Slå på notiser");
  });

  it("en ägare med en telefon räcker: ingen rad", () => {
    expect(
      reachLine({
        members: [member(), member({ channels: ["push", "email"], devices: 1 })],
        works: NO_MAIL,
      }),
    ).toBeNull();
  });

  it("säger som det är när varken notiser eller e-post finns", () => {
    const line = reachLine({
      members: [member()],
      works: { email: false, push: false, sms: false },
    });
    expect(line?.detail).toBe(
      "Larmen syns bara här i appen. Varken notiser eller e-post är påslagna för Binderlab.",
    );
    expect(line?.action).toBe("Öppna Notiser");
  });
});

describe("kontrollen har inte körts", () => {
  const created = "2026-11-03T06:00:00Z";

  it("aldrig körd av sig själv i en gammal organisation", () => {
    const line = selfCheckLine(
      { lastScheduledAt: null, organizationCreatedAt: created },
      NOW,
      when,
    );
    expect(line?.title).toBe("Kontrollen har aldrig körts av sig själv");
    expect(line?.href).toBe("/installningar/kontroll");
  });

  it("säger när den senast kördes", () => {
    const line = selfCheckLine(
      { lastScheduledAt: "2026-11-17T04:37:00Z", organizationCreatedAt: created },
      NOW,
      when,
    );
    expect(line?.title).toBe("Kontrollen har inte körts sedan <2026-11-17T04:37>");
  });

  it("ingen rad när den kördes i morse, eller när organisationen är ny", () => {
    expect(
      selfCheckLine(
        { lastScheduledAt: "2026-11-19T04:37:00Z", organizationCreatedAt: created },
        NOW,
        when,
      ),
    ).toBeNull();
    expect(
      selfCheckLine(
        { lastScheduledAt: null, organizationCreatedAt: "2026-11-19T08:00:00Z" },
        NOW,
        when,
      ),
    ).toBeNull();
  });
});

describe("hämtningen står still", () => {
  const source = (over: Partial<SyncSourceFacts> = {}): SyncSourceFacts => ({
    id: "s1",
    name: "Awish",
    lastSuccessAt: "2026-11-19T11:55:00Z",
    lastRunAt: "2026-11-19T11:55:00Z",
    lastError: null,
    failures: 0,
    createdAt: "2026-11-03T06:00:00Z",
    ...over,
  });

  it("färsk hämtning: inget", () => {
    expect(syncBroken(source(), NOW)).toBe(false);
    expect(syncLine(source(), NOW, when)).toBeNull();
  });

  it("tre fel i rad larmar direkt, också inom 30 minuter", () => {
    const s = source({
      lastSuccessAt: "2026-11-19T11:45:00Z",
      failures: 3,
      lastError: "Awish svarade inte i tid",
    });
    expect(syncBroken(s, NOW)).toBe(true);
    const line = syncLine(s, NOW, when);
    expect(line?.level).toBe("critical");
    expect(line?.title).toBe("Försäljningen har inte hämtats sedan <2026-11-19T11:45>");
    expect(line?.detail).toContain("Awish svarar med fel: Awish svarade inte i tid");
  });

  it("30 minuter utan lyckad hämtning larmar, även när inget försök har gjorts", () => {
    const s = source({ lastSuccessAt: "2026-11-19T11:20:00Z", lastRunAt: "2026-11-19T11:20:00Z" });
    expect(syncLine(s, NOW, when)?.detail).toContain("Hämtningen körs inte alls just nu.");
  });

  it("två fel inom 30 minuter larmar inte än", () => {
    expect(syncBroken(source({ failures: 2, lastSuccessAt: "2026-11-19T11:50:00Z" }), NOW)).toBe(
      false,
    );
  });

  it("en källa som aldrig har lyckats larmar först när den är äldre än 30 minuter", () => {
    expect(
      syncBroken(source({ lastSuccessAt: null, createdAt: "2026-11-19T11:50:00Z" }), NOW),
    ).toBe(false);
    const old = source({ lastSuccessAt: null, lastRunAt: null });
    expect(syncLine(old, NOW, when)?.title).toBe("Försäljningen har aldrig hämtats");
  });
});

describe("larmjobbet", () => {
  it("säger till när larmen inte har kontrollerats på över ett dygn", () => {
    const line = alertRunLine(
      { lastRunAt: "2026-11-17T05:07:00Z", organizationCreatedAt: "2026-11-03T06:00:00Z" },
      NOW,
      when,
    );
    expect(line?.title).toBe("Larmen har inte kontrollerats sedan <2026-11-17T05:07>");
    expect(
      alertRunLine(
        { lastRunAt: "2026-11-19T05:07:00Z", organizationCreatedAt: "2026-11-03T06:00:00Z" },
        NOW,
        when,
      ),
    ).toBeNull();
  });
});

describe("datans ålder per automat", () => {
  it("skriver åldern kort", () => {
    expect(ageText(0)).toBe("nyss");
    expect(ageText(3)).toBe("3 min sedan");
    expect(ageText(130)).toBe("2 tim 10 min sedan");
    expect(ageText(60 * 7 + 5)).toBe("7 tim sedan");
    expect(ageText(60 * 24 * 3)).toBe("3 dygn sedan");
  });

  it("alla färska: en lugn rad", () => {
    const ages = machineAges(
      [
        { machineId: "a", label: "BL-001", seenAt: "2026-11-19T11:57:00Z" },
        { machineId: "b", label: "BL-002", seenAt: "2026-11-19T11:56:00Z" },
      ],
      NOW,
    );
    expect(machineAgeSummary(ages)).toEqual({
      stale: false,
      text: "Data från Awish: alla 2 automater, 4 min sedan.",
    });
  });

  it("en automat som släpar nämns vid namn med sin ålder", () => {
    const ages = machineAges(
      [
        { machineId: "a", label: "BL-001", seenAt: "2026-11-19T11:57:00Z" },
        { machineId: "b", label: "BL-003", seenAt: "2026-11-19T09:50:00Z" },
        { machineId: "c", label: "BL-004", seenAt: null },
      ],
      NOW,
    );
    expect(machineAgeSummary(ages)).toEqual({
      stale: true,
      text: "Gammal data från Awish: BL-003 2 tim 10 min sedan, BL-004 aldrig. Övriga 3 min sedan.",
    });
  });

  it("inga automater: ingen rad", () => {
    expect(machineAgeSummary([])).toBeNull();
  });
});

describe("allt samlat", () => {
  it("hämtningen först, sedan vem som nås, larmjobbet och kontrollen", () => {
    const lines = watchLines(
      {
        reach: { members: [member()], works: NO_MAIL },
        selfCheck: { lastScheduledAt: null, organizationCreatedAt: "2026-11-03T06:00:00Z" },
        sync: [
          {
            id: "s1",
            name: "Awish",
            lastSuccessAt: "2026-11-19T09:00:00Z",
            lastRunAt: "2026-11-19T11:55:00Z",
            lastError: "UNAVAILABLE",
            failures: 30,
            createdAt: "2026-11-03T06:00:00Z",
          },
        ],
        alertRun: { lastRunAt: null, organizationCreatedAt: "2026-11-03T06:00:00Z" },
      },
      NOW,
      when,
    );
    expect(lines.map((l) => l.key)).toEqual(["synk:s1", "larm-nar-ingen", "larmjobb", "kontroll"]);
  });

  it("allt fungerar: inga rader", () => {
    expect(
      watchLines(
        {
          reach: { members: [member({ channels: ["push"], devices: 1 })], works: NO_MAIL },
          selfCheck: {
            lastScheduledAt: "2026-11-19T04:37:00Z",
            organizationCreatedAt: "2026-11-03T06:00:00Z",
          },
          sync: [],
          alertRun: {
            lastRunAt: "2026-11-19T11:55:00Z",
            organizationCreatedAt: "2026-11-03T06:00:00Z",
          },
        },
        NOW,
        when,
      ),
    ).toEqual([]);
  });
});
