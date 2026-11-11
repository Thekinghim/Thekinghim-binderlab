/**
 * Startlistan per ny butik (storeStartList, startListHeadline i ./model): fem bockar i fast
 * ordning och en knapp för nästa steg som saknas.
 */

import { describe, expect, it } from "vitest";

import { startListHeadline, storeStartList, type StoreStartFacts } from "./model";

const store = (over: {
  contract?: "signed" | "unsigned" | "missing";
  machineCodes?: string[];
}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Kafé Ett",
  href: "/butiker/11111111-1111-4111-8111-111111111111",
  contract: over.contract ?? "missing",
  machineCodes: over.machineCodes ?? [],
});

const facts = (over: Partial<StoreStartFacts> = {}): StoreStartFacts => ({
  hasTerms: false,
  recipients: 0,
  portal: { users: 0, pending: 0 },
  ...over,
});

const ticks = (l: ReturnType<typeof storeStartList>) =>
  l.steps.map((s) => `${s.done ? "x" : " "} ${s.label}`);

describe("storeStartList", () => {
  it("fem bockar i fast ordning", () => {
    const l = storeStartList({ store: store({}), facts: facts(), freeMachineCode: null });
    expect(l.steps.map((s) => s.label)).toEqual([
      "Villkor",
      "Kontrakt signerat",
      "Automat placerad",
      "Rapportmottagare",
      "Portal-inbjudan",
    ]);
    expect(l.progress).toBe("0 av 5 klart");
    expect(l.next).toEqual({
      id: "villkor",
      label: "Lägg in villkor",
      href: "/butiker/11111111-1111-4111-8111-111111111111?vy=avtal",
    });
    expect(l.ready).toBe(false);
  });

  it("villkor men osignerat kontrakt: 1 av 5 och knappen Signera", () => {
    const l = storeStartList({
      store: store({ contract: "unsigned" }),
      facts: facts({ hasTerms: true }),
      freeMachineCode: null,
    });
    expect(ticks(l)).toEqual([
      "x Villkor",
      "  Kontrakt signerat",
      "  Automat placerad",
      "  Rapportmottagare",
      "  Portal-inbjudan",
    ]);
    expect(l.progress).toBe("1 av 5 klart");
    expect(l.next?.label).toBe("Signera");
    expect(l.next?.href).toBe("/avtal#butik-11111111-1111-4111-8111-111111111111");
    expect(l.ready).toBe(false);
  });

  it("villkor men inget kontrakt alls: knappen Skapa kontrakt", () => {
    const l = storeStartList({
      store: store({ contract: "missing" }),
      facts: facts({ hasTerms: true }),
      freeMachineCode: null,
    });
    expect(l.next?.label).toBe("Skapa kontrakt");
    expect(l.next?.href).toBe("/avtal?skapa=store%3A11111111-1111-4111-8111-111111111111");
  });

  it("signerat: klar för automat, och knappen öppnar en automat utan butik direkt", () => {
    const ready = { store: store({ contract: "signed" }), facts: facts({ hasTerms: true }) };
    const l = storeStartList({ ...ready, freeMachineCode: "BL-004" });
    expect(l.ready).toBe(true);
    expect(l.next).toEqual({
      id: "automat",
      label: "Placera automat",
      href: "/automater/bl-004?gor=placera",
    });
    expect(storeStartList({ ...ready, freeMachineCode: null }).next?.href).toBe("/automater");
  });

  it("efter automaten: mottagare, sedan portalen (en inbjudan räcker), sedan ingen knapp", () => {
    const placed = store({ contract: "signed", machineCodes: ["BL-004"] });
    const a = storeStartList({
      store: placed,
      facts: facts({ hasTerms: true }),
      freeMachineCode: null,
    });
    expect(a.next?.label).toBe("Lägg till mottagare");
    const b = storeStartList({
      store: placed,
      facts: facts({ hasTerms: true, recipients: 1 }),
      freeMachineCode: null,
    });
    expect(b.next?.label).toBe("Bjud in till portalen");
    const c = storeStartList({
      store: placed,
      facts: facts({ hasTerms: true, recipients: 1, portal: { users: 0, pending: 1 } }),
      freeMachineCode: null,
    });
    expect(c.next).toBeNull();
    expect(c.progress).toBe("5 av 5 klart");
  });

  it("läsaren ser inte portalen: fyra bockar", () => {
    const l = storeStartList({
      store: store({}),
      facts: facts({ portal: null }),
      freeMachineCode: null,
    });
    expect(l.total).toBe(4);
    expect(l.steps.some((s) => s.id === "portal")).toBe(false);
  });
});

describe("startListHeadline", () => {
  it("2 av 4 butiker är klara för automat", () => {
    expect(
      startListHeadline([{ ready: true }, { ready: false }, { ready: true }, { ready: false }]),
    ).toBe("2 av 4 butiker är klara för automat.");
    expect(startListHeadline([{ ready: true }, { ready: true }])).toBe(
      "Alla 2 butiker är klara för automat.",
    );
    expect(startListHeadline([{ ready: true }])).toBe("Butiken är klar för automat.");
    expect(startListHeadline([{ ready: false }])).toBe("Butiken är inte klar för automat än.");
  });
});
