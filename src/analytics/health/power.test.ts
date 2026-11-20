import { describe, expect, it } from "vitest";

import {
  connectivitySignals,
  connectivityView,
  EMPTY_CONNECTIVITY,
  nextConnectivity,
  offlineSinceMs,
  type ConnectivityState,
  type MachineConnectivity,
} from "./connectivity";
import {
  explainingWindow,
  isPowerOffAt,
  parsePowerTime,
  POWER_ON_GRACE_MINUTES,
  powerHoursOf,
  powerOffWindowAt,
  powerVerdict,
  wallClockMs,
  type PowerHours,
} from "./power";

const NIGHT: PowerHours = { on: "10:00", off: "21:00" };
const RULE = { leadMinutes: 20 } as const;
const at = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();

describe("strömtider: tolkning", () => {
  it("läser TT:MM och Postgres-tid, avvisar fel", () => {
    expect(parsePowerTime("10:00")).toBe(600);
    expect(parsePowerTime("21:30:00")).toBe(21 * 60 + 30);
    expect(parsePowerTime("24:00")).toBeNull();
    expect(parsePowerTime("9.00")).toBeNull();
    expect(parsePowerTime(null)).toBeNull();
  });

  it("båda tider och olika, annars alltid på", () => {
    expect(powerHoursOf("10:00", "21:00")).toEqual({ on: "10:00", off: "21:00" });
    expect(powerHoursOf("10:00", null)).toBeNull();
    expect(powerHoursOf(null, null)).toBeNull();
    expect(powerHoursOf("10:00", "10:00")).toBeNull();
  });
});

describe("strömtider: väggtid och sommartid", () => {
  it("väggtid blir rätt tidpunkt vinter och sommar", () => {
    expect(iso(wallClockMs("2026-11-20", 21 * 60, "Europe/Stockholm"))).toBe(
      "2026-11-20T20:00:00.000Z",
    );
    expect(iso(wallClockMs("2026-07-01", 21 * 60, "Europe/Stockholm"))).toBe(
      "2026-07-01T19:00:00.000Z",
    );
  });

  it("klockslag som inte finns (02:30 när sommartiden börjar) blir 03:30", () => {
    expect(iso(wallClockMs("2026-03-29", 2 * 60 + 30, "Europe/Stockholm"))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("natten när sommartiden börjar är en timme kortare", () => {
    const w = powerOffWindowAt(NIGHT, at("2026-03-29T03:00:00Z"));
    expect(w).not.toBeNull();
    expect(iso(w!.offMs)).toBe("2026-03-28T20:00:00.000Z"); // 21:00 CET
    expect(iso(w!.onMs)).toBe("2026-03-29T08:00:00.000Z"); // 10:00 CEST
    expect((w!.onMs - w!.offMs) / 3_600_000).toBe(12);
  });

  it("natten när sommartiden slutar är en timme längre", () => {
    const w = powerOffWindowAt(NIGHT, at("2026-10-25T03:00:00Z"));
    expect(iso(w!.offMs)).toBe("2026-10-24T19:00:00.000Z"); // 21:00 CEST
    expect(iso(w!.onMs)).toBe("2026-10-25T09:00:00.000Z"); // 10:00 CET
    expect((w!.onMs - w!.offMs) / 3_600_000).toBe(14);
  });
});

describe("strömtider: av och på", () => {
  it("av 21:00–10:00 (vintertid)", () => {
    expect(isPowerOffAt(NIGHT, at("2026-11-20T19:59:00Z"))).toBe(false); // 20:59
    expect(isPowerOffAt(NIGHT, at("2026-11-20T20:00:00Z"))).toBe(true); // 21:00
    expect(isPowerOffAt(NIGHT, at("2026-11-21T02:00:00Z"))).toBe(true); // 03:00
    expect(isPowerOffAt(NIGHT, at("2026-11-21T08:59:00Z"))).toBe(true); // 09:59
    expect(isPowerOffAt(NIGHT, at("2026-11-21T09:00:00Z"))).toBe(false); // 10:00
    expect(isPowerOffAt(NIGHT, at("2026-11-21T12:00:00Z"))).toBe(false); // 13:00
  });

  it("av efter midnatt (av 01:00, på 07:00)", () => {
    const late: PowerHours = { on: "07:00", off: "01:00" };
    expect(isPowerOffAt(late, at("2026-11-20T23:30:00Z"))).toBe(false); // 00:30
    expect(isPowerOffAt(late, at("2026-11-21T00:00:00Z"))).toBe(true); // 01:00
    expect(isPowerOffAt(late, at("2026-11-21T05:59:00Z"))).toBe(true); // 06:59
    expect(isPowerOffAt(late, at("2026-11-21T06:00:00Z"))).toBe(false); // 07:00
  });

  it("utan strömtider är strömmen alltid på", () => {
    expect(isPowerOffAt(null, at("2026-11-21T02:00:00Z"))).toBe(false);
    expect(explainingWindow(null, at("2026-11-21T02:00:00Z"), RULE)).toBeNull();
  });
});

describe("strömtider: bedömningen av en offlineperiod", () => {
  const off2105 = at("2026-11-20T20:05:00Z"); // 21:05

  it("offline på natten: strömmen av tills på-tiden plus marginalen", () => {
    const v = powerVerdict(NIGHT, off2105, at("2026-11-21T03:00:00Z"), RULE);
    expect(v.kind).toBe("power_off");
    if (v.kind !== "power_off") return;
    expect(iso(v.onMs)).toBe("2026-11-21T09:00:00.000Z");
    expect(v.untilMs - v.onMs).toBe(POWER_ON_GRACE_MINUTES * 60_000);
    // 10:20: automaten startar fortfarande.
    expect(powerVerdict(NIGHT, off2105, at("2026-11-21T09:20:00Z"), RULE).kind).toBe("power_off");
  });

  it("inte tillbaka efter marginalen: avbrott från på-tiden", () => {
    const v = powerVerdict(NIGHT, off2105, at("2026-11-21T09:30:00Z"), RULE);
    expect(v).toEqual({ kind: "outage", fromMs: at("2026-11-21T09:00:00Z") });
  });

  it("butiken stänger av lite tidigt (20:50): räknas som strömmen av", () => {
    const v = powerVerdict(NIGHT, at("2026-11-20T19:50:00Z"), at("2026-11-20T20:30:00Z"), RULE);
    expect(v.kind).toBe("power_off");
  });

  it("offline mitt på dagen är ett riktigt avbrott, också när natten kommer", () => {
    const from = at("2026-11-20T14:00:00Z"); // 15:00
    expect(powerVerdict(NIGHT, from, at("2026-11-20T15:00:00Z"), RULE)).toEqual({
      kind: "outage",
      fromMs: from,
    });
    expect(powerVerdict(NIGHT, from, at("2026-11-20T23:00:00Z"), RULE)).toEqual({
      kind: "outage",
      fromMs: from,
    });
  });

  it("tappar anslutningen under uppstarten (10:10): larmar först efter marginalen", () => {
    const from = at("2026-11-21T09:10:00Z");
    expect(powerVerdict(NIGHT, from, at("2026-11-21T09:25:00Z"), RULE).kind).toBe("power_off");
    expect(powerVerdict(NIGHT, from, at("2026-11-21T09:40:00Z"), RULE)).toEqual({
      kind: "outage",
      fromMs: from,
    });
  });
});

describe("anslutningen med strömtider", () => {
  const base: MachineConnectivity = {
    machineId: "m1",
    online: false,
    status: "0",
    seenAt: "2026-11-21T02:00:00.000Z",
    onlineAt: "2026-11-20T20:00:00.000Z",
    offlineSince: "2026-11-20T20:05:00.000Z",
    backOnlineAt: null,
    lastOfflineFrom: null,
    power: NIGHT,
  };

  it("på natten: strömmen av, inget offline och ingen offlinehändelse", () => {
    const now = "2026-11-21T02:00:00.000Z";
    expect(offlineSinceMs(base, now)).toBeNull();
    expect(connectivityView(base, now)).toEqual({
      state: "power_off",
      since: base.offlineSince,
      until: "2026-11-21T09:00:00.000Z",
    });
    expect(connectivitySignals([base], now).some((s) => s.kind === "offline")).toBe(false);
  });

  it("samma automat utan strömtider är offline (som förut)", () => {
    const now = "2026-11-21T02:00:00.000Z";
    const plain = { ...base, power: null };
    expect(connectivityView(plain, now).state).toBe("offline");
    expect(connectivitySignals([plain], now).some((s) => s.kind === "offline")).toBe(true);
  });

  it("inte tillbaka 10:30: offline sedan 10:00, och larmet kommer", () => {
    const now = "2026-11-21T09:31:00.000Z";
    const c = { ...base, seenAt: now };
    expect(connectivityView(c, now)).toEqual({
      state: "offline",
      since: "2026-11-21T09:00:00.000Z",
    });
    const sig = connectivitySignals([c], now).find((s) => s.kind === "offline");
    expect(sig?.at).toBe("2026-11-21T09:00:00.000Z");
  });

  it("tillbaka inom marginalen: ingen avslutad offlineperiod i händelserna", () => {
    const now = "2026-11-21T09:30:00.000Z";
    const back = {
      ...base,
      online: true,
      seenAt: now,
      onlineAt: now,
      offlineSince: null,
      backOnlineAt: "2026-11-21T09:05:00.000Z",
      lastOfflineFrom: "2026-11-20T20:05:00.000Z",
    };
    expect(connectivityView(back, now).state).toBe("online");
    expect(connectivitySignals([back], now).some((s) => s.kind === "offline")).toBe(false);
  });

  it("avbrott på dagen syns och larmar som förut", () => {
    const now = "2026-11-21T13:00:00.000Z";
    const day = {
      ...base,
      seenAt: now,
      onlineAt: "2026-11-21T12:00:00.000Z",
      offlineSince: "2026-11-21T12:10:00.000Z",
    };
    expect(connectivityView(day, now).state).toBe("offline");
    expect(offlineSinceMs(day, now)).toBe(at("2026-11-21T12:10:00Z"));
  });
});

describe("fladder och strömtider (kort blink på kvällen, sedan strömmen av)", () => {
  /** Lokal tid i Stockholm (vintertid, +01:00) dag `day` i november 2026. */
  const L = (day: number, hhmm: string) => `2026-11-${day}T${hhmm}:00+01:00`;

  /** Synken var femte minut; online i [from, to) enligt `online`. */
  function run(power: PowerHours | null, plan: [string, string, boolean][]) {
    let c: ConnectivityState = EMPTY_CONNECTIVITY;
    const offlineAt: string[] = [];
    for (const [from, to, online] of plan) {
      for (let t = Date.parse(from); t < Date.parse(to); t += 5 * 60_000) {
        c = nextConnectivity(c, { isOnline: online, status: null }, t, power);
        const since = offlineSinceMs({ ...c, power }, t);
        if (since !== null) offlineAt.push(iso(t));
      }
    }
    return { c, offlineAt };
  }

  const blink: [string, string, boolean][] = [
    [L(20, "20:00"), L(20, "20:30"), true],
    [L(20, "20:30"), L(20, "20:45"), false],
    [L(20, "20:45"), L(20, "21:05"), true],
    [L(20, "21:05"), L(21, "10:05"), false],
    [L(21, "10:05"), L(21, "11:00"), true],
  ];

  it("med strömtider: aldrig offline, och natten blir en egen period", () => {
    const { c, offlineAt } = run(NIGHT, blink);
    expect(offlineAt).toEqual([]);
    expect(c.lastOfflineFrom).toBe(iso(at(L(20, "21:05"))));
  });

  it("utan strömtider: samma fladder som förut (perioden från blinken 20:30)", () => {
    const { offlineAt } = run(null, blink);
    expect(offlineAt[0]).toBe(iso(at(L(20, "21:05"))));
    const c = nextConnectivity(
      nextConnectivity(
        nextConnectivity(
          { ...EMPTY_CONNECTIVITY, online: true, onlineAt: L(20, "20:00") },
          { isOnline: false, status: null },
          L(20, "20:30"),
        ),
        { isOnline: true, status: null },
        L(20, "20:45"),
      ),
      { isOnline: false, status: null },
      L(20, "21:05"),
    );
    expect(c.offlineSince).toBe(iso(at(L(20, "20:30"))));
  });

  it("inte tillbaka på morgonen: offline sedan 10:00, larmar efter marginalen", () => {
    const { offlineAt } = run(NIGHT, [
      ...blink.slice(0, 3),
      [L(20, "21:05"), L(21, "11:00"), false],
    ]);
    expect(offlineAt[0]).toBe(iso(at(L(21, "10:30"))));
    const c = run(NIGHT, [...blink.slice(0, 3), [L(20, "21:05"), L(21, "10:35"), false]]).c;
    expect(offlineSinceMs({ ...c, power: NIGHT }, L(21, "10:30"))).toBe(at(L(21, "10:00")));
  });

  it("fladder mitt på dagen fortsätter samma period, också med strömtider", () => {
    const { c, offlineAt } = run(NIGHT, [
      [L(20, "13:00"), L(20, "14:00"), true],
      [L(20, "14:00"), L(20, "14:10"), false],
      [L(20, "14:10"), L(20, "14:20"), true],
      [L(20, "14:20"), L(20, "14:40"), false],
    ]);
    expect(c.offlineSince).toBe(iso(at(L(20, "14:00"))));
    expect(offlineAt[0]).toBe(iso(at(L(20, "14:20"))));
  });

  it("avbrott från eftermiddagen, tillbaka en stund 20:50, sedan strömmen av: inget larm på natten", () => {
    const { offlineAt } = run(NIGHT, [
      [L(20, "14:00"), L(20, "15:00"), true],
      [L(20, "15:00"), L(20, "20:50"), false],
      [L(20, "20:50"), L(20, "21:00"), true],
      [L(20, "21:00"), L(21, "10:05"), false],
    ]);
    // Larmar på eftermiddagen (riktigt avbrott), men inte efter att automaten kom tillbaka.
    expect(offlineAt[0]).toBe(iso(at(L(20, "15:20"))));
    expect(offlineAt.at(-1)).toBe(iso(at(L(20, "20:45"))));
  });
});
