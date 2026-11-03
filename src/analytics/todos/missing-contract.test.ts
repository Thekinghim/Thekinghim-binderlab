import { describe, expect, it } from "vitest";

import { createTodoContext } from "./context";
import { computeTodos } from "./index";
import { missingContractTodos } from "./missing-contract";
import type { TodoInput } from "./types";

const base: TodoInput = {
  orders: [],
  prices: [],
  agreements: [],
  placements: [
    { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
    { machineId: "m2", storeId: "s2", from: "2026-01-01", to: null },
    // Flyttad: står inte i butik 3 i dag.
    { machineId: "m3", storeId: "s3", from: "2026-01-01", to: "2026-10-31" },
  ],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
  titles: [],
  machines: [
    { id: "m1", name: "Automat 1", code: "BL-001", activeFrom: null, activeTo: null },
    { id: "m2", name: "Automat 2", code: "BL-002", activeFrom: null, activeTo: null },
    { id: "m3", name: "Automat 3", code: "BL-003", activeFrom: null, activeTo: null },
  ],
  stores: [
    { id: "s1", name: "Sega gubben" },
    { id: "s2", name: "Kafé Ett" },
    { id: "s3", name: "Butik Tre" },
  ],
  stock: [],
  reportRecipients: [],
  reportDeliveries: [],
};

const NOW = new Date("2026-11-03T10:00:00Z");

describe("missingContractTodos", () => {
  it("butik med automat utan kontrakt: Skapa kontrakt; osignerat: Signera", () => {
    const ctx = createTodoContext(
      {
        ...base,
        contracts: [
          {
            id: "c2",
            storeId: "s2",
            validFrom: "2026-11-01",
            validTo: null,
            template: "placering-vinstdelning-v1",
          },
        ],
      },
      NOW,
    );
    const todos = missingContractTodos(ctx);
    expect(todos.map((t) => [t.key, t.title, t.action?.label, t.link])).toEqual([
      [
        "contract-missing:s1",
        "Sega gubben saknar kontrakt",
        "Skapa kontrakt",
        "/avtal?skapa=store%3As1",
      ],
      [
        "contract-missing:s2",
        "Kafé Ett: kontraktet är inte signerat",
        "Signera",
        "/avtal#butik-s2",
      ],
    ]);
    expect(todos[0]).toMatchObject({ kind: "contract", level: "soon", fingerprint: "missing" });
    expect(todos[0]!.detail).toBe("BL-001 står där.");
  });

  it("signerat eller registrerat för hand: ingen punkt; finns i computeTodos", () => {
    const input: TodoInput = {
      ...base,
      contracts: [
        { id: "c1", storeId: "s1", validFrom: "2026-01-01", validTo: null, template: null },
        {
          id: "c2",
          storeId: "s2",
          validFrom: "2026-01-01",
          validTo: null,
          template: "t",
          signedAt: "2026-02-01T10:00:00Z",
        },
      ],
    };
    expect(missingContractTodos(createTodoContext(input, NOW))).toEqual([]);
    const all = computeTodos({ ...base, contracts: [] }, NOW);
    expect(all.filter((t) => t.key.startsWith("contract-missing:")).length).toBe(2);
  });
});
