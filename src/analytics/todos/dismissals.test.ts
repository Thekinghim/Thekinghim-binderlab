import { describe, expect, it } from "vitest";
import { applyDismissals, computeTodos, obsoleteDismissals } from "./index";
import { daily, input, NOW, title } from "./test-helpers";
import type { TodoInput } from "./types";

const scenario = (
  onHand: number,
  lastRefilledAt: string | null,
  lastRestockedAt: string | null = lastRefilledAt,
): TodoInput =>
  input({
    titles: [title("t1", "Black Bolt")],
    orders: daily("t1", "m1", "2026-10-19", 14, 2),
    prices: [{ titleId: "t1", unitCostOre: 2_500, validFrom: "2026-01-01" }],
    stock: [{ machineId: "m1", titleId: "t1", onHand, lastRestockedAt, lastRefilledAt }],
  });

describe("avbockning", () => {
  it("döljer punkten så länge orsaken är oförändrad", () => {
    const todos = computeTodos(scenario(4, "2026-10-20T08:00:00Z"), NOW);
    const [t] = todos;
    expect(t).toBeDefined();
    const dismissals = [{ key: t!.key, fingerprint: t!.fingerprint }];
    expect(applyDismissals(todos, dismissals)).toHaveLength(0);
    // Samma saldo och ingen ny påfyllning: fortfarande dold.
    expect(
      applyDismissals(computeTodos(scenario(4, "2026-10-20T08:00:00Z"), NOW), dismissals),
    ).toHaveLength(0);
  });

  it("en inventering som inte ändrar saldot låter avbockningen stå kvar", () => {
    const [t] = computeTodos(scenario(4, null, "2026-11-01T12:20:00Z"), NOW);
    const dismissals = [{ key: t!.key, fingerprint: t!.fingerprint }];
    expect(
      applyDismissals(computeTodos(scenario(4, null, "2026-11-02T07:20:00Z"), NOW), dismissals),
    ).toHaveLength(0);
  });

  it("Klar döljer inte en påfyllning medan automaten töms (BL-001, 4 nov.)", () => {
    // Avbockad vid 4 pack; ingen påfyllning registrerad, bara inventeringen 3 nov. Ett pack
    // till säljs: punkten ska synas igen, annars säger Att göra "Inget i dag" fast Lager
    // säger Akut.
    const [t] = computeTodos(scenario(4, null, "2026-11-01T12:20:00Z"), NOW);
    const dismissals = [{ key: t!.key, fingerprint: t!.fingerprint }];
    const later = applyDismissals(
      computeTodos(scenario(3, null, "2026-11-01T12:20:00Z"), NOW),
      dismissals,
    );
    expect(later.map((x) => x.key)).toEqual(["refill:m1:t1"]);
  });

  it("visar punkten igen när orsaken ändras", () => {
    const [t] = computeTodos(scenario(4, "2026-10-20T08:00:00Z"), NOW);
    const dismissals = [{ key: t!.key, fingerprint: t!.fingerprint }];
    // Lagret tog slut (nivån ändras).
    expect(
      applyDismissals(computeTodos(scenario(0, "2026-10-20T08:00:00Z"), NOW), dismissals),
    ).toHaveLength(1);
    // Påfyllning registrerades, men lagret är lågt igen.
    expect(
      applyDismissals(computeTodos(scenario(4, "2026-10-31T08:00:00Z"), NOW), dismissals),
    ).toHaveLength(1);
  });

  it("avbockningar som inte längre döljer något kan rensas", () => {
    const todos = computeTodos(scenario(4, "2026-10-20T08:00:00Z"), NOW);
    const keep = { key: todos[0]!.key, fingerprint: todos[0]!.fingerprint };
    const changed = { key: todos[0]!.key, fingerprint: "now|gammal" };
    const solved = { key: "refill:m9:t9", fingerprint: "soon|-" };
    expect(obsoleteDismissals(todos, [keep, changed, solved])).toEqual([changed, solved]);
  });

  it("behåller ordningen", () => {
    const todos = computeTodos(
      input({
        titles: [title("t1", "A"), title("t2", "B")],
        orders: [
          ...daily("t1", "m1", "2026-10-19", 14, 2),
          ...daily("t2", "m1", "2026-10-19", 14, 4),
        ],
        stock: [
          { machineId: "m1", titleId: "t1", onHand: 1 },
          { machineId: "m1", titleId: "t2", onHand: 2 },
        ],
      }),
      NOW,
    );
    expect(applyDismissals(todos, [])).toEqual(todos);
  });
});
