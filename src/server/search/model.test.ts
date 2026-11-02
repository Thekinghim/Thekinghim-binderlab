import { describe, expect, it } from "vitest";

import type { MachineRecord, StoreRecord, TitleRecord } from "@/server/data/core/types";

import {
  cleanSearch,
  containsPattern,
  formatOrderedAt,
  formatPaid,
  looksLikeOrderNumber,
  machineLabel,
  masterGroups,
  orderGroup,
  orderGroups,
  orderTerms,
  pricePick,
  refillPick,
  searchTerms,
  type OrderSearchRow,
  type SearchMaster,
} from "./model";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const T3 = "00000000-0000-4000-8000-000000000003";
const M1 = "00000000-0000-4000-8000-0000000000a1";
const M2 = "00000000-0000-4000-8000-0000000000a2";
const S1 = "00000000-0000-4000-8000-0000000000b1";

const title = (id: string, name: string, extra: Partial<TitleRecord> = {}): TitleRecord => ({
  id,
  name,
  series: null,
  mergedIntoId: null,
  archived: false,
  ...extra,
});

const machine = (
  id: string,
  code: string,
  name: string,
  storeId: string | null,
): MachineRecord => ({
  id,
  code,
  name,
  serial: null,
  storeId,
  isExample: false,
  archived: false,
  activeFrom: null,
  activeTo: null,
});

const store: StoreRecord = {
  id: S1,
  name: "Mobilia",
  address: "Per Albin Hanssons väg 40, Malmö",
  contactName: null,
  email: null,
  phone: null,
  isExample: false,
  archived: false,
};

const master: SearchMaster = {
  titles: [
    title(T1, "Ascended Heroes", { series: "Mega Evolution" }),
    title(T2, "Pokémon 151"),
    title(T3, "Gammal titel", { archived: true }),
  ],
  machines: [machine(M1, "BL-001", "Centrum", S1), machine(M2, "BL-002", "Gallerian", null)],
  stores: [store],
  aliases: new Map([[T2, ["Pokemon 151 booster pack"]]]),
};

const NOW = new Date("2026-11-02T12:00:00Z");

/** Formateringen använder hårda mellanslag; jämför med vanliga. */
const plain = (v: string) => v.replace(/\u00a0/g, " ");

const row = (over: Partial<OrderSearchRow> = {}): OrderSearchRow => ({
  id: "o1",
  externalId: "42780",
  orderedAt: "2026-11-01T16:17:00Z",
  amountOre: 17000,
  rawTitle: "30th Celebration",
  titleId: null,
  machineId: M1,
  ...over,
});

describe("söktexten", () => {
  it("trimmar, slår ihop blanktecken och kapar", () => {
    expect(cleanSearch("  42780   bl-001 ")).toBe("42780 bl-001");
    expect(cleanSearch("x".repeat(300))).toHaveLength(100);
    expect(cleanSearch(null)).toBe("");
  });

  it("delar i unika ord", () => {
    expect(searchTerms("Asc asc BL-001")).toEqual(["Asc", "BL-001"]);
  });

  it("skyddar LIKE-tecken", () => {
    expect(containsPattern("10%_a\\b")).toBe("%10\\%\\_a\\\\b%");
  });

  it("känner igen ordernummer", () => {
    expect(looksLikeOrderNumber("42780")).toBe(true);
    expect(looksLikeOrderNumber("42")).toBe(false);
    expect(looksLikeOrderNumber("BL-001")).toBe(false);
  });
});

describe("stamdata", () => {
  it("ger titlar, automater och butiker med länkar för ägaren", () => {
    const groups = masterGroups("asc", master, "owner");
    expect(groups.map((g) => g.kind)).toEqual(["title"]);
    expect(groups[0]!.hits[0]).toMatchObject({
      label: "Ascended Heroes",
      href: `/inkopspriser?titel=${T1}`,
      carry: "all",
      meta: ["Mega Evolution"],
    });
  });

  it("automaten heter som i resten av panelen och visar butiken", () => {
    const [g] = masterGroups("bl-001", master, "viewer");
    expect(g!.hits[0]).toMatchObject({
      label: "BL-001 Centrum",
      meta: ["Mobilia"],
      href: `/automater/${M1}`,
    });
    expect(machineLabel({ code: "BL-003", name: "BL-003 Kiosken" })).toBe("BL-003 Kiosken");
  });

  it("butiken hittas på adress och visar antal automater", () => {
    const groups = masterGroups("malmö", master, "owner");
    expect(groups.find((g) => g.kind === "store")!.hits[0]).toMatchObject({
      label: "Mobilia",
      meta: ["1 automat"],
      href: `/butiker/${S1}`,
    });
  });

  it("titeln hittas på alias och utan diakritik", () => {
    expect(masterGroups("booster pack", master, "owner")[0]!.hits[0]!.entityId).toBe(T2);
    expect(masterGroups("pokemon", master, "owner")[0]!.hits[0]!.entityId).toBe(T2);
  });

  it("arkiverade titlar kommer inte med", () => {
    expect(masterGroups("gammal", master, "owner")).toEqual([]);
  });

  it("påfyllaren: titeln startar en påfyllning, automat och butik leder till Lager", () => {
    const t = masterGroups("asc", master, "refiller")[0]!.hits[0]!;
    expect(t.step).toBe("refill-machine");
    expect(t.href).toBeUndefined();
    const m = masterGroups("bl-001", master, "refiller")[0]!.hits[0]!;
    expect(m).toMatchObject({ href: `/lager?automat=${M1}`, carry: "period" });
    const s = masterGroups("mobilia", master, "refiller").find((g) => g.kind === "store")!;
    expect(s.hits[0]).toMatchObject({ href: `/lager?butik=${S1}`, carry: "period" });
  });
});

describe("order", () => {
  it("söker inte i order utan ett ord på minst tre tecken", () => {
    expect(orderTerms("42", master)).toBeNull();
    expect(orderTerms("a b", master)).toBeNull();
  });

  it("översätter ord till titlar och automater", () => {
    const terms = orderTerms("pokemon bl-002", master)!;
    expect(terms[0]).toMatchObject({ text: "pokemon", titleIds: [T2], machineIds: [] });
    expect(terms[1]).toMatchObject({ text: "bl-002", titleIds: [], machineIds: [M2] });
  });

  it("visar ordernummer, titel, automat, tid och belopp", () => {
    const g = orderGroup({
      q: "4278",
      role: "owner",
      exact: [],
      recent: [row()],
      more: false,
      master,
      timeZone: "Europe/Stockholm",
      now: NOW,
    })!;
    expect(g.hits[0]).toMatchObject({ code: "42780", label: "30th Celebration", carry: "none" });
    expect(g.hits[0]!.meta.map(plain)).toEqual(["BL-001", "1 nov. 17:17", "170 kr"]);
    expect(g.hits[0]!.href).toBe("/order?period=allt&q=42780&order=o1");
    expect(g.more).toBeUndefined();
  });

  it("exakt ordernummer först, utan dubbletter, och länk till alla träffar", () => {
    const exact = row({ id: "x", externalId: "151" });
    const g = orderGroup({
      q: "151",
      role: "admin",
      exact: [exact],
      recent: [row({ id: "a", externalId: "1510" }), exact],
      more: true,
      master,
      timeZone: "Europe/Stockholm",
      now: NOW,
    })!;
    expect(g.hits.map((h) => h.entityId)).toEqual(["x", "a"]);
    expect(g.more).toEqual({
      label: "Alla order som matchar ”151”",
      href: "/order?period=allt&q=151",
    });
  });

  it("påfyllaren får aldrig någon ordergrupp", () => {
    expect(
      orderGroup({
        q: "4278",
        role: "refiller",
        exact: [row()],
        recent: [row()],
        more: true,
        master,
        timeZone: "Europe/Stockholm",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("belopp och tider", () => {
    expect(plain(formatPaid(17000))).toBe("170 kr");
    expect(plain(formatPaid(7950))).toBe("79,50 kr");
    expect(plain(formatOrderedAt("2025-12-28T16:17:00Z", "Europe/Stockholm", NOW))).toBe(
      "28 dec. 2025 17:17",
    );
  });

  it("ordernummer först i gruppordningen, annars sist", () => {
    const g = (kind: "order" | "title" | "machine" | "store") => ({ kind, label: kind, hits: [] });
    expect(orderGroups("42780", [g("title"), g("order")]).map((x) => x.kind)).toEqual([
      "order",
      "title",
    ]);
    expect(
      orderGroups("asc", [g("order"), null, g("store"), g("title")]).map((x) => x.kind),
    ).toEqual(["title", "store", "order"]);
  });
});

describe("steg", () => {
  it("påfyllning: titlarna i automaten först, minst kvar först, i antal pack", () => {
    const groups = refillPick(
      master.titles,
      new Map([
        [T2, 2],
        [T1, 7],
      ]),
    );
    expect(groups[0]!.items.map((i) => [i.label, i.meta[0]])).toEqual([
      ["Pokémon 151", "2 st kvar"],
      ["Ascended Heroes", "7 st kvar"],
    ]);
    expect(groups).toHaveLength(1);
  });

  it("inköpspris: titlar utan pris först", () => {
    const groups = pricePick(master.titles, new Set([T1]));
    expect(groups.map((g) => g.label)).toEqual(["Saknar inköpspris", "Med inköpspris"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([T2]);
  });
});
