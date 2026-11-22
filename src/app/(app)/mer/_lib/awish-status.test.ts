import { describe, expect, it } from "vitest";

import type { SyncInfo } from "@/server/data/core/types";

import { awishLinkStatus } from "./awish-status";

const time = (iso: string) => iso.slice(11, 16);
const sync = (state: SyncInfo["state"], syncedAt: string | null = "2026-11-22T21:23:00Z") =>
  ({ state, syncedAt, sources: 1 }) satisfies SyncInfo;

describe("awishLinkStatus (Mer → Kopplingar)", () => {
  it("demo: avstängt som på Datakällor, även när synken ser färsk ut", () => {
    expect(awishLinkStatus({ sync: sync("ok"), demo: true, time })).toEqual({
      label: "Avstängt i demon",
      tone: "neutral",
      sub: "Inga anrop till Awish i demon",
    });
    expect(awishLinkStatus({ sync: null, demo: true, time }).label).toBe("Avstängt i demon");
  });

  it("ansluten bara när synken är färsk", () => {
    expect(awishLinkStatus({ sync: sync("ok"), demo: false, time })).toEqual({
      label: "Ansluten",
      tone: "ok",
      sub: "Köp och fack, var 5:e minut · senast 21:23",
    });
    expect(awishLinkStatus({ sync: sync("no-orders", null), demo: false, time }).label).toBe(
      "Ansluten",
    );
  });

  it("gammal synk är inaktuell (inte Ansluten, inte Fel)", () => {
    expect(awishLinkStatus({ sync: sync("stale"), demo: false, time })).toEqual({
      label: "Inaktuell",
      tone: "warning",
      sub: "Ingen synk på länge · senast 21:23",
    });
  });

  it("fel och ingen källa", () => {
    expect(awishLinkStatus({ sync: sync("failed"), demo: false, time }).label).toBe("Fel");
    expect(awishLinkStatus({ sync: null, demo: null, time })).toMatchObject({
      label: "Ej ansluten",
      tone: "critical",
    });
  });
});
