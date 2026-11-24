import { describe, expect, it } from "vitest";

import {
  awishErrorText,
  awishFreshnessText,
  awishLines,
  awishStatusLines,
  longFallbacks,
  ordersBannerText,
  watchLines,
  type AwishPathFacts,
  type AwishWatchFacts,
} from "./index";

const NOW = new Date("2026-11-24T12:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const when = (iso: string) => `<${iso.slice(11, 16)}>`;

const path = (over: Partial<AwishPathFacts> = {}): AwishPathFacts => ({
  sourceId: "s1",
  path: "stock",
  activeRoute: "open_api",
  lastSuccessAt: ago(3),
  lastSuccessRoute: "open_api",
  lastAttemptAt: ago(3),
  lastErrorAt: null,
  lastErrorKind: null,
  lastErrorCode: null,
  failingSince: null,
  breakerRoute: null,
  breakerOpenUntil: null,
  fallbackSince: null,
  ...over,
});

const facts = (paths: AwishPathFacts[], push: AwishWatchFacts["push"] = null): AwishWatchFacts => ({
  paths,
  push,
});

/** Reservvägen fungerar: Products ger INTERNAL sedan 03:00, facken läses via webbpanelen. */
const viaWeb = path({
  activeRoute: "webbpanelen",
  lastSuccessRoute: "webbpanelen",
  lastErrorAt: ago(3),
  lastErrorKind: "server",
  lastErrorCode: 13,
  fallbackSince: ago(9 * 60),
});

describe("lagret", () => {
  it("reservvägen fungerar: inget larm, bara en statusrad", () => {
    expect(awishLines(facts([viaWeb]), NOW, when)).toEqual([]);
    expect(awishStatusLines(facts([viaWeb]), when)).toEqual([
      {
        key: "awish-reserv:stock",
        text: "Lager i automaterna: via webbpanelen sedan <03:00> (Open API: Awish internt fel).",
      },
    ]);
  });

  it("ingen väg i 30 min: ett kritiskt larm; under 30 min inget", () => {
    const broken = path({
      activeRoute: "senast_kanda",
      lastSuccessAt: ago(31),
      failingSince: ago(26),
      lastErrorAt: ago(1),
      lastErrorKind: "unavailable",
    });
    const [line] = awishLines(facts([broken]), NOW, when);
    expect(line).toMatchObject({
      key: "awish:stock",
      level: "critical",
      title: `Lagret har inte lästs sedan ${when(ago(31))}`,
      href: "/datakallor#awish-halsa",
    });
    expect(line!.detail).toContain("Varken Open API eller webbpanelen svarar (Awish svarar inte).");
    expect(awishLines(facts([{ ...broken, lastSuccessAt: ago(29) }]), NOW, when)).toEqual([]);
    expect(awishStatusLines(facts([broken]), when)).toEqual([]);
  });

  it("inloggningen till webbpanelen: säger att lösenordet ska bytas", () => {
    const auth = path({
      activeRoute: "ingen",
      lastSuccessAt: ago(40),
      failingSince: ago(35),
      lastErrorKind: "auth",
      lastErrorAt: ago(1),
    });
    expect(awishLines(facts([auth]), NOW, when)[0]!.detail).toContain("Byt lösenord i Datakällor");
  });

  it("aldrig läst: räknas från första felet", () => {
    const never = path({ lastSuccessAt: null, failingSince: ago(45), activeRoute: "ingen" });
    expect(awishLines(facts([never]), NOW, when)[0]!.title).toBe(
      "Lagret har aldrig lästs från Awish",
    );
  });

  it("flera källor: den som släpar mest", () => {
    const ok = path({ sourceId: "a" });
    const bad = path({ sourceId: "b", lastSuccessAt: ago(50), failingSince: ago(45) });
    expect(awishLines(facts([ok, bad]), NOW, when)).toHaveLength(1);
  });
});

describe("automaternas status", () => {
  const machines = (minutes: number) =>
    path({
      path: "machines",
      activeRoute: "senast_kanda",
      lastSuccessAt: ago(minutes),
      failingSince: ago(minutes - 5),
      lastErrorKind: "unavailable",
      lastErrorCode: 14,
    });

  it("30 min varning, 2 h kritisk", () => {
    expect(awishLines(facts([machines(20)]), NOW, when)).toEqual([]);
    const [warn] = awishLines(facts([machines(31)]), NOW, when);
    expect(warn).toMatchObject({
      key: "awish:machines",
      level: "warning",
      title: `Vi vet inte om automaterna är online sedan ${when(ago(31))}`,
    });
    expect(awishLines(facts([machines(121)]), NOW, when)[0]!.level).toBe("critical");
  });
});

describe("påfyllningar", () => {
  it("väntar mer än 60 min: kritiskt; kortare: inget", () => {
    expect(awishLines(facts([], { pendingMachines: 2, oldestAt: ago(59) }), NOW, when)).toEqual([]);
    const [line] = awishLines(facts([], { pendingMachines: 2, oldestAt: ago(61) }), NOW, when);
    expect(line).toMatchObject({
      key: "awish:push",
      level: "critical",
      title: "Påfyllningarna i 2 automater har inte nått Awish",
      href: "/fyll-pa",
    });
    expect(
      awishLines(facts([], { pendingMachines: 1, oldestAt: ago(90) }), NOW, when)[0]!.title,
    ).toBe("Påfyllningen i en automat har inte nått Awish");
  });

  it("inloggningen fungerar inte: kritiskt direkt", () => {
    const auth = path({
      path: "push",
      activeRoute: "ingen",
      lastSuccessAt: ago(2),
      failingSince: ago(1),
      lastErrorKind: "auth",
      lastErrorAt: ago(1),
    });
    const [line] = awishLines(facts([auth], { pendingMachines: 1, oldestAt: ago(1) }), NOW, when);
    expect(line).toMatchObject({
      key: "awish:push",
      level: "critical",
      title: "Inloggningen till webbpanelen fungerar inte",
    });
  });

  it("brytaren öppen efter inloggningsfel räknas också", () => {
    const open = path({
      path: "push",
      lastErrorKind: "auth",
      breakerRoute: "webbpanelen",
      breakerOpenUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(awishLines(facts([open]), NOW, when)).toHaveLength(1);
    const closed = { ...open, breakerOpenUntil: ago(1) };
    expect(awishLines(facts([closed]), NOW, when)).toEqual([]);
  });
});

describe("vakten samlat", () => {
  it("awish-raderna ingår, kritiska först", () => {
    const machines = path({
      path: "machines",
      lastSuccessAt: ago(40),
      failingSince: ago(35),
      activeRoute: "senast_kanda",
    });
    const stock = path({ lastSuccessAt: ago(40), failingSince: ago(35), activeRoute: "ingen" });
    const lines = watchLines(
      {
        reach: null,
        selfCheck: null,
        sync: [],
        alertRun: null,
        awish: facts([machines, stock]),
      },
      NOW,
      when,
    );
    expect(lines.map((l) => [l.key, l.level])).toEqual([
      ["awish:stock", "critical"],
      ["awish:machines", "warning"],
    ]);
  });
});

describe("texter", () => {
  it("felkoder på enkel svenska", () => {
    expect(awishErrorText("server", 13)).toBe("Awish internt fel");
    expect(awishErrorText("unavailable", 14)).toBe("Awish svarar inte");
    expect(awishErrorText("timeout", null)).toBe("Awish svarar för långsamt");
    expect(awishErrorText("auth")).toBe("inloggningen fungerar inte");
    expect(awishErrorText(null)).toBe("okänt fel");
  });

  it("färskheten på Hem och Drift", () => {
    expect(
      awishFreshnessText({ ordersAt: ago(2), stockAt: ago(4), stockVia: "webbpanelen" }, when),
    ).toBe(`Försäljning ${when(ago(2))} · Lager ${when(ago(4))} (via webbpanelen)`);
    expect(awishFreshnessText({ ordersAt: ago(2), stockAt: null, stockVia: null }, when)).toBe(
      `Försäljning ${when(ago(2))}`,
    );
    expect(awishFreshnessText({ ordersAt: null, stockAt: null, stockVia: null }, when)).toBeNull();
  });

  it("bannern på Hem", () => {
    expect(ordersBannerText(ago(45), when)).toBe(
      `Försäljningen är inte uppdaterad sedan ${when(ago(45))}. Awish svarar inte. Ladda upp orderlistan i Datakällor.`,
    );
  });

  it("reservvägen längre än ett dygn", () => {
    expect(longFallbacks([viaWeb], NOW)).toEqual([]);
    const long = { ...viaWeb, fallbackSince: ago(25 * 60) };
    expect(longFallbacks([long], NOW)).toEqual([long]);
  });
});

describe("webbpanelen som vanlig väg (påfyllningar, varor, fack)", () => {
  it("ingen statusrad och ingen varning om reservväg, hur länge det än har varit så", () => {
    const pushViaWeb = path({
      path: "push",
      activeRoute: "webbpanelen",
      lastSuccessRoute: "webbpanelen",
      fallbackSince: ago(3 * 24 * 60),
    });
    const goodsViaWeb = { ...pushViaWeb, path: "goods" as const };
    expect(awishStatusLines(facts([pushViaWeb, goodsViaWeb]), when)).toEqual([]);
    expect(longFallbacks([pushViaWeb, goodsViaWeb], NOW)).toEqual([]);
  });
});

describe("automater som inte läses fast lagret fungerar", () => {
  const linked = (readMinutesAgo: number | null) => ({
    readAt: readMinutesAgo === null ? null : ago(readMinutesAgo),
    linkedAt: ago(10 * 24 * 60),
  });

  it("en av tre inte läst på 45 min: en varning (inte kritisk) med tiden", () => {
    const f: AwishWatchFacts = {
      ...facts([path()]),
      linkedStock: [linked(3), linked(4), linked(45)],
    };
    const lines = awishLines(f, NOW, when);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      key: "awish:stock",
      level: "warning",
      title: `En automat har inte lästs från Awish sedan ${when(ago(45))}`,
    });
  });

  it("alla lästa nyligen: inget; aldrig läst sedan kopplingen: sägs", () => {
    expect(
      awishLines({ ...facts([path()]), linkedStock: [linked(3), linked(20)] }, NOW, when),
    ).toEqual([]);
    const never = awishLines(
      { ...facts([path()]), linkedStock: [linked(3), linked(null), linked(null)] },
      NOW,
      when,
    );
    expect(never[0]?.title).toBe("2 automater har aldrig lästs från Awish");
  });

  it("hela lagret trasigt: det kritiska larmet gäller, inte varningen", () => {
    const broken = path({
      activeRoute: "senast_kanda",
      lastSuccessAt: ago(50),
      failingSince: ago(45),
      lastErrorKind: "unavailable",
    });
    const lines = awishLines(
      { ...facts([broken]), linkedStock: [linked(50), linked(50)] },
      NOW,
      when,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("critical");
  });
});

describe("429 från webbpanelen", () => {
  it("på enkel svenska", () => {
    expect(awishErrorText("rate_limited")).toBe("Awish tar inte emot fler anrop just nu");
  });
});
