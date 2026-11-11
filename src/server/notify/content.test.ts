import { describe, expect, it } from "vitest";

import type { AlertDelivery, AlertNotification } from "@/analytics/alerts";
import { evidence } from "@/analytics/todos/common";
import type { IsoDate } from "@/domain";

import {
  caseLink,
  faultPush,
  fillLink,
  machineLabel,
  pushPayload,
  pushPayloads,
  refillPush,
  VISIT_PLAN_LINK,
  type PushContext,
  type PushMachine,
} from "./content";

const TODAY = "2026-11-12" as IsoDate; // torsdag
const TOMORROW = "2026-11-13" as IsoDate;
const SATURDAY = "2026-11-14" as IsoDate;

function low(
  machineId: string,
  titleId: string,
  kind: "empty" | "soon",
  end: IsoDate | null = null,
  title = `Titel ${titleId} är slut i ${machineId}`,
): AlertNotification {
  return {
    incidentId: `${machineId}-${titleId}`,
    key: `low_stock:${machineId}:${titleId}`,
    kind: "low_stock",
    severity: kind === "empty" ? "critical" : "warning",
    reason: "new",
    machineId,
    titleId,
    title,
    detail: "0 pack kvar.",
    at: "2026-11-12T10:00:00Z",
    evidence: evidence({ rule: "test", dates: end ? [end] : [] }),
    link: `/lager?automat=${machineId}`,
  };
}

function delivery(items: AlertNotification[]): AlertDelivery {
  return {
    userId: "u1",
    sendAt: "2026-11-12T10:00:00.000Z",
    deferred: false,
    subject: items.length > 1 ? `${items.length} larm` : (items[0]?.title ?? ""),
    items,
  } as AlertDelivery;
}

const machine = (name: string, store: string | null, open?: PushMachine["open"]): PushMachine => ({
  name,
  store,
  ...(open ? { open } : {}),
});

describe("machineLabel", () => {
  it("automat och butik; butiken skrivs inte två gånger", () => {
    expect(machineLabel(machine("BL-003", "Sega gubben"), "x")).toBe("BL-003 Sega gubben");
    expect(machineLabel(machine("BL-003 Sega gubben", "Sega Gubben"), "x")).toBe(
      "BL-003 Sega gubben",
    );
    expect(machineLabel(machine("BL-003", null), "x")).toBe("BL-003");
    expect(machineLabel(undefined, "Okänd")).toBe("Okänd");
  });
});

describe("push om påfyllning", () => {
  it("7 larm för en automat blir en notis med automatens namn, antal och länk till Fyll på", () => {
    const items = [
      ...["t1", "t2", "t3"].map((t) => low("m3", t, "empty")),
      ...["t4", "t5"].map((t) => low("m3", t, "soon", TOMORROW)),
      ...["t6", "t7"].map((t) => low("m3", t, "soon", TOMORROW)),
    ];
    const ctx: PushContext = {
      today: TODAY,
      machines: new Map([["m3", machine("BL-003", "Sega gubben")]]),
    };
    const out = pushPayloads(delivery(items), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      title: "BL-003 Sega gubben",
      body: "3 slut, 4 tar slut i morgon. Tryck för att fylla på.",
      url: "/fyll-pa/m3",
      tag: "fyll-m3",
      severity: "critical",
    });
    expect(fillLink("m3")).toBe("/fyll-pa/m3");
  });

  it("automatens hela läge (öppna larm) står i notisen, inte bara det som är nytt", () => {
    const ctx: PushContext = {
      today: TODAY,
      machines: new Map([
        [
          "m3",
          machine("BL-003", "Sega gubben", { empty: 3, soon: 2, soonDates: [SATURDAY, SATURDAY] }),
        ],
      ]),
    };
    const out = refillPush(delivery([low("m3", "t1", "empty")]), ctx);
    expect(out?.body).toBe("3 slut, 2 tar slut på lördag. Tryck för att fylla på.");
  });

  it("olika dagar eller okänd dag: 'snart'; i dag: 'i dag'", () => {
    const ctx = (dates: IsoDate[]): PushContext => ({
      today: TODAY,
      machines: new Map([["m3", machine("BL-003", null, { empty: 0, soon: 2, soonDates: dates })]]),
    });
    const d = delivery([low("m3", "t1", "soon"), low("m3", "t2", "soon")]);
    expect(refillPush(d, ctx([TOMORROW, SATURDAY]))?.body).toBe(
      "2 tar slut snart. Tryck för att fylla på.",
    );
    expect(refillPush(d, ctx([TOMORROW]))?.body).toBe("2 tar slut snart. Tryck för att fylla på.");
    expect(refillPush(d, ctx([TODAY, TODAY]))?.body).toBe(
      "2 tar slut i dag. Tryck för att fylla på.",
    );
    expect(refillPush(d, ctx([TODAY, TODAY]))?.severity).toBe("warning");
  });

  it("en enda titel: notisen säger vilken, utan att upprepa automatens namn", () => {
    const ctx: PushContext = {
      today: TODAY,
      machines: new Map([["m3", machine("BL-003", "Sega gubben")]]),
    };
    const out = refillPush(
      delivery([low("m3", "t1", "empty", null, "Prismatic Evolutions är slut i BL-003")]),
      ctx,
    );
    expect(out).toMatchObject({
      title: "BL-003 Sega gubben",
      body: "Prismatic Evolutions är slut. Tryck för att fylla på.",
      url: "/fyll-pa/m3",
    });
  });

  it("flera automater: en notis, värst först, till besöksplanen", () => {
    const items = [
      low("m1", "t1", "empty"),
      ...["t1", "t2"].map((t) => low("m7", t, "empty")),
      ...["t1", "t2", "t3"].map((t) => low("m3", t, "empty")),
      ...["t4", "t5"].map((t) => low("m3", t, "soon", TOMORROW)),
    ];
    const ctx: PushContext = {
      today: TODAY,
      machines: new Map([
        ["m1", machine("BL-001", "ICA Lund")],
        ["m3", machine("BL-003", "Sega gubben")],
        ["m7", machine("BL-007", null)],
      ]),
    };
    const out = pushPayloads(delivery(items), ctx);
    expect(out).toEqual([
      {
        title: "3 automater behöver fyllas på",
        body: "BL-003 (5), BL-007 (2), BL-001 (1)",
        url: VISIT_PLAN_LINK,
        tag: "fyll-flera",
        severity: "critical",
      },
    ]);
  });

  it("lagerlarm och andra larm i samma utskick: två notiser, den andra som förut", () => {
    const offline: AlertNotification = {
      ...low("m1", "x", "empty"),
      key: "machine:m1",
      kind: "machine_offline",
      title: "BL-001 är offline sedan 14:30",
      detail: "Ingen kontakt.",
      link: "/drift/automat/m1",
    };
    const out = pushPayloads(delivery([offline, low("m3", "t1", "empty")]), { today: TODAY });
    expect(out).toHaveLength(2);
    expect(out[0]?.url).toBe("/fyll-pa/m3");
    expect(out[1]).toMatchObject({
      title: "BL-001 är offline sedan 14:30",
      url: "/drift/automat/m1",
      tag: "machine:m1",
    });
  });

  it("utan lagerlarm, eller bara 'löst': notisen är som förut", () => {
    const solved = { ...low("m3", "t1", "empty"), reason: "resolved" as const };
    const d = delivery([solved]);
    expect(refillPush(d)).toBeNull();
    expect(pushPayloads(d)).toEqual([pushPayload(d)]);
  });

  it("på engelska för den som har engelska (delägaren): antal, dag och 'Tap to refill.'", () => {
    const base = {
      today: TODAY,
      lang: "en" as const,
      machines: new Map([["m3", machine("BL-003", "Sega gubben")]]),
    };
    const one = refillPush(delivery([low("m3", "t1", "empty")]), base);
    expect(one).toMatchObject({
      title: "BL-003 Sega gubben",
      body: "1\u00a0empty. Tap to refill.",
      url: "/fyll-pa/m3",
      lang: "en",
    });
    const mixed = refillPush(
      delivery([low("m3", "t1", "empty"), low("m3", "t2", "soon", SATURDAY)]),
      base,
    );
    expect(mixed?.body).toBe("1\u00a0empty, 1\u00a0runs out on Saturday. Tap to refill.");
    const many = refillPush(delivery([low("m3", "t1", "empty"), low("m1", "t1", "empty")]), base);
    expect(many).toMatchObject({ title: "2\u00a0machines need refilling", lang: "en" });
    // Enkel vy har ingen besöksplan: flera automater går till listan i Fyll på.
    expect(many?.url).toBe("/drift/besok");
    const simple = refillPush(delivery([low("m3", "t1", "empty"), low("m1", "t1", "empty")]), {
      ...base,
      simple: true,
    });
    expect(simple?.url).toBe("/fyll-pa");
    // Svenska har ingen lang (som förut).
    expect(refillPush(delivery([low("m3", "t1", "empty")]), { today: TODAY })).not.toHaveProperty(
      "lang",
    );
  });

  it("utan uppgifter om automaten faller notisen tillbaka på larmets rubrik", () => {
    const out = refillPush(delivery([low("m3", "t1", "empty"), low("m3", "t2", "empty")]));
    expect(out).toMatchObject({
      title: "Titel t1 är slut i m3",
      body: "2 slut. Tryck för att fylla på.",
      url: "/fyll-pa/m3",
    });
  });
});

describe("push om butikens felanmälan", () => {
  const base = {
    incidentId: "i1",
    machineId: "m3",
    place: "Sega gubben",
    fault: "Betalningen fungerar inte",
    phone: "040-12 34 56",
    canOpenCase: true,
  };

  it("ägare och admin: butik och fel i rubriken, trycket öppnar ärendet", () => {
    expect(faultPush(base)).toEqual({
      title: "Sega gubben: Betalningen fungerar inte",
      body: "Butiken har felanmält automaten. Tryck för att ringa butiken.",
      url: "/inkorg/i1",
      tag: "fel-i1",
      severity: "critical",
    });
    expect(caseLink("i1")).toBe("/inkorg/i1");
  });

  it("utan telefonnummer: tryck för att öppna ärendet", () => {
    expect(faultPush({ ...base, phone: null }).body).toBe(
      "Butiken har felanmält automaten. Tryck för att öppna ärendet.",
    );
    expect(faultPush({ ...base, phone: "  " }).body).toBe(
      "Butiken har felanmält automaten. Tryck för att öppna ärendet.",
    );
  });

  it("påfyllaren: numret i texten och länken till Fyll på", () => {
    expect(faultPush({ ...base, canOpenCase: false })).toMatchObject({
      body: "Butiken har felanmält automaten. Ring butiken: 040-12 34 56.",
      url: "/fyll-pa/m3",
    });
    expect(faultPush({ ...base, canOpenCase: false, phone: null }).body).toBe(
      "Butiken har felanmält automaten. Säg till ägaren.",
    );
  });

  it("en mycket lång rubrik kortas", () => {
    const long = faultPush({ ...base, place: "B".repeat(200) });
    expect(long.title).toHaveLength(120);
    expect(long.title.endsWith("…")).toBe(true);
  });
});
