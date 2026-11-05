import { describe, expect, it } from "vitest";

import {
  CONNECTIVITY_STATE_PREFIX,
  connectivitySignals,
  connectivityView,
  EMPTY_CONNECTIVITY,
  nextConnectivity,
  offlineSinceMs,
  type ConnectivityState,
} from "./connectivity";
import { machineHealth } from "./status";

const T0 = Date.parse("2026-11-02T13:00:00Z"); // 14:00 i Stockholm
const min = (n: number) => T0 + n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Kör en följd av svar (is_online) med tio minuters mellanrum från T0. */
function run(seq: readonly boolean[], start: ConnectivityState = EMPTY_CONNECTIVITY) {
  let s = start;
  const states: ConnectivityState[] = [];
  seq.forEach((online, i) => {
    s = nextConnectivity(s, { isOnline: online, status: online ? "1" : "0" }, min(i * 10));
    states.push(s);
  });
  return states;
}

describe("nextConnectivity", () => {
  it("online sätter senast online; offline startar en period", () => {
    const [a, b] = run([true, false]);
    expect(a?.onlineAt).toBe(iso(min(0)));
    expect(a?.offlineSince).toBeNull();
    expect(b?.online).toBe(false);
    expect(b?.offlineSince).toBe(iso(min(10)));
    expect(b?.onlineAt).toBe(iso(min(0)));
  });

  it("en automat som aldrig varit online får ingen offlineperiod", () => {
    const states = run([false, false, false, false]);
    const last = states.at(-1)!;
    expect(last.online).toBe(false);
    expect(last.offlineSince).toBeNull();
    expect(last.onlineAt).toBeNull();
    expect(offlineSinceMs(last, min(60))).toBeNull();
    expect(connectivitySignals([{ ...last, machineId: "m1" }], min(40))).toEqual([]);
  });

  it("perioden slutar först efter 20 minuter online (fladder)", () => {
    // online, offline ×3, online (tillbaka), offline (fladder), offline
    const states = run([true, false, false, false, true, false, false]);
    expect(states[4]?.backOnlineAt).toBe(iso(min(40)));
    expect(states[4]?.offlineSince).toBe(iso(min(10)));
    // Tillbaka offline inom 20 minuter: samma period fortsätter.
    expect(states[5]?.offlineSince).toBe(iso(min(10)));
    expect(states[5]?.backOnlineAt).toBeNull();
    expect(states[6]?.offlineSince).toBe(iso(min(10)));
  });

  it("online i 20 minuter avslutar perioden och sparar den", () => {
    const states = run([true, false, false, false, true, true, true]);
    expect(states[5]?.offlineSince).toBe(iso(min(10)));
    const done = states[6]!;
    expect(done.offlineSince).toBeNull();
    expect(done.lastOfflineFrom).toBe(iso(min(10)));
    expect(done.backOnlineAt).toBe(iso(min(40)));
  });
});

describe("offline efter 20 minuter", () => {
  it("offline 10 och 19 minuter: inte offline; 20 minuter: offline sedan periodens början", () => {
    const states = run([true, false, false, false]);
    const s = states.at(-1)!;
    expect(offlineSinceMs(s, min(29))).toBeNull();
    expect(offlineSinceMs(s, min(30))).toBe(min(10));
    expect(connectivityView(s, min(29)).state).toBe("online");
    expect(connectivityView(s, min(30))).toEqual({ state: "offline", since: iso(min(10)) });
  });

  it("gammalt läge (synken har slutat läsa) används inte", () => {
    const s = run([true, false]).at(-1)!;
    expect(offlineSinceMs(s, min(10 + 61))).toBeNull();
    expect(connectivityView(s, min(10 + 61)).state).toBe("unknown");
    expect(connectivitySignals([{ ...s, machineId: "m1" }], min(10 + 61))).toEqual([]);
  });

  it("kort avbrott (under 20 minuter) larmar inte", () => {
    const states = run([true, false, true, true, true]);
    for (const [i, s] of states.entries()) {
      expect(offlineSinceMs(s, min(i * 10))).toBeNull();
    }
  });
});

describe("connectivitySignals → maskinhälsan", () => {
  const machines = [
    { id: "m1", name: "Centrum", code: "BL-001", activeFrom: null, activeTo: null },
  ];
  const healthAt = (s: ConnectivityState, at: number) =>
    machineHealth(
      {
        machines,
        orders: [],
        signals: connectivitySignals([{ ...s, machineId: "m1" }], at),
        options: { timeZone: "Europe/Stockholm" },
      },
      at,
    )[0]!;

  it("offline i 20 minuter: 'BL-001 är offline sedan 14:10'", () => {
    const s = run([true, false, false, false]).at(-1)!;
    const h = healthAt(s, min(30));
    expect(h.status).toBe("offline");
    expect(h.source).toBe("vendor");
    expect(h.title).toBe("BL-001 är offline sedan 14:10");
    expect(h.since).toBe(iso(min(10)));
  });

  it("online: känd anslutning ('online'-läget syns inte som händelse i tidslinjen)", () => {
    const s = run([true]).at(-1)!;
    const signals = connectivitySignals([{ ...s, machineId: "m1" }], min(0));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id.startsWith(CONNECTIVITY_STATE_PREFIX)).toBe(true);
    expect(healthAt(s, min(0)).status).not.toBe("offline");
  });

  it("tillbaka online: inte offline; avslutad period blir offline + online igen", () => {
    const states = run([true, false, false, false, true, true, true]);
    const back = states[4]!;
    expect(healthAt(back, min(40)).status).not.toBe("offline");
    const done = states[6]!;
    const signals = connectivitySignals([{ ...done, machineId: "m1" }], min(60));
    expect(signals.map((x) => [x.kind, x.at])).toEqual([
      ["offline", iso(min(10))],
      ["online", iso(min(40))],
      ["online", iso(min(60))],
    ]);
    expect(healthAt(done, min(60)).status).not.toBe("offline");
  });
});
