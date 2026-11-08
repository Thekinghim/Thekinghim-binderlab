import { describe, expect, it } from "vitest";

import {
  ATTEMPT_KEY,
  MAX_AUTO_RELOADS,
  RETRY_AFTER_MS,
  autoReloadAllowed,
  decideUpdate,
  isNewBuild,
  nextAttempt,
  readAttempt,
  settleAttempt,
  writeAttempt,
  type StorageLike,
  type UpdateAttempt,
} from "./app-version";

function memory(
  initial: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const NOW = 1_800_000_000_000;

describe("isNewBuild", () => {
  it("olika giltiga id: ny version", () => {
    expect(isNewBuild("dpl_A", "dpl_B")).toBe(true);
  });
  it("samma id: ingen ny version", () => {
    expect(isNewBuild("dpl_A", "dpl_A")).toBe(false);
  });
  it.each([
    [null, "dpl_B"],
    ["dpl_A", null],
    ["", "dpl_B"],
    ["dpl_A", ""],
    ["dpl_A", "<script>"],
    ["dpl_A", "x".repeat(81)],
    ["dpl_A", 42],
  ])("ogiltigt id (%s, %s): aldrig ny version", (a, b) => {
    expect(isNewBuild(a, b)).toBe(false);
  });
});

describe("decideUpdate", () => {
  const base = {
    current: "A",
    live: "B",
    unsaved: false,
    attempt: null,
    now: NOW,
  } as const;

  it("ingen ny version: inget", () => {
    expect(decideUpdate({ ...base, live: "A", trigger: "resume" })).toBe("none");
    expect(decideUpdate({ ...base, live: null, trigger: "resume" })).toBe("none");
  });

  it("när sidan laddas och var femte minut: bara rutan", () => {
    expect(decideUpdate({ ...base, trigger: "load" })).toBe("banner");
    expect(decideUpdate({ ...base, trigger: "interval" })).toBe("banner");
  });

  it("appen öppnas igen och inget är ifyllt: laddar om själv", () => {
    expect(decideUpdate({ ...base, trigger: "resume" })).toBe("auto");
  });

  it("osparade antal (Fyll på): aldrig omladdning, bara rutan", () => {
    expect(decideUpdate({ ...base, trigger: "resume", unsaved: true })).toBe("banner");
  });

  it("samma uppdatering provades nyss utan resultat: rutan i stället för en slinga", () => {
    const attempt: UpdateAttempt = { from: "A", to: "B", at: NOW - 1000, autoCount: 1 };
    expect(decideUpdate({ ...base, trigger: "resume", attempt })).toBe("banner");
  });
});

describe("skydd mot omladdning i en slinga", () => {
  it("inget tidigare försök: tillåtet", () => {
    expect(autoReloadAllowed(null, "A", "B", NOW)).toBe(true);
  });

  it("samma uppdatering inom tio minuter: inte tillåtet", () => {
    const attempt = { from: "A", to: "B", at: NOW - RETRY_AFTER_MS + 1, autoCount: 1 };
    expect(autoReloadAllowed(attempt, "A", "B", NOW)).toBe(false);
  });

  it("samma uppdatering efter tio minuter: tillåtet igen", () => {
    const attempt = { from: "A", to: "B", at: NOW - RETRY_AFTER_MS, autoCount: 1 };
    expect(autoReloadAllowed(attempt, "A", "B", NOW)).toBe(true);
  });

  it("en ännu nyare version: tillåtet", () => {
    const attempt = { from: "A", to: "B", at: NOW - 1000, autoCount: 1 };
    expect(autoReloadAllowed(attempt, "A", "C", NOW)).toBe(true);
  });

  it("högst två automatiska omladdningar per session, vad som än händer", () => {
    const attempt = { from: "B", to: "C", at: 0, autoCount: MAX_AUTO_RELOADS };
    expect(autoReloadAllowed(attempt, "C", "D", NOW)).toBe(false);
  });

  it("en klocka som gått bakåt räknas inte som 'nyss'", () => {
    const attempt = { from: "A", to: "B", at: NOW + 60_000, autoCount: 1 };
    expect(autoReloadAllowed(attempt, "A", "B", NOW)).toBe(true);
  });

  it("hela förloppet: en omladdning, sedan bara rutan", () => {
    const storage = memory();
    // 1. Appen öppnas igen: ny version, ladda om.
    let { attempt } = readAttempt(storage);
    expect(
      decideUpdate({
        current: "A",
        live: "B",
        trigger: "resume",
        unsaved: false,
        attempt,
        now: NOW,
      }),
    ).toBe("auto");
    writeAttempt(storage, nextAttempt(attempt, { from: "A", to: "B", now: NOW, auto: true }));
    // 2. Efter omladdningen är sidan fortfarande gammal (t.ex. en cache på vägen).
    ({ attempt } = readAttempt(storage));
    attempt = settleAttempt(attempt, "A");
    for (const trigger of ["load", "resume", "interval"] as const) {
      expect(
        decideUpdate({
          current: "A",
          live: "B",
          trigger,
          unsaved: false,
          attempt,
          now: NOW + 2000,
        }),
      ).toBe("banner");
    }
  });

  it("lyckad uppdatering: försöket är klart, räknaren finns kvar", () => {
    const attempt = { from: "A", to: "B", at: NOW, autoCount: 1 };
    const settled = settleAttempt(attempt, "B");
    expect(settled).toEqual({ from: "B", to: "B", at: 0, autoCount: 1 });
    expect(autoReloadAllowed(settled, "B", "C", NOW)).toBe(true);
    expect(settleAttempt(null, "B")).toBeNull();
  });

  it("manuellt tryck räknas inte som automatisk omladdning", () => {
    const a = nextAttempt(null, { from: "A", to: "B", now: NOW, auto: false });
    expect(a.autoCount).toBe(0);
    expect(nextAttempt(a, { from: "A", to: "B", now: NOW, auto: true }).autoCount).toBe(1);
  });
});

describe("lagringen", () => {
  it("sparar och läser försöket", () => {
    const storage = memory();
    const attempt = { from: "A", to: "B", at: NOW, autoCount: 1 };
    expect(writeAttempt(storage, attempt)).toBe(true);
    expect(readAttempt(storage)).toEqual({ usable: true, attempt });
  });

  it("trasigt eller okänt värde: inget försök", () => {
    expect(readAttempt(memory({ [ATTEMPT_KEY]: "{" })).attempt).toBeNull();
    expect(readAttempt(memory({ [ATTEMPT_KEY]: '{"from":"A"}' })).attempt).toBeNull();
    expect(
      readAttempt(memory({ [ATTEMPT_KEY]: '{"from":"<x>","to":"B","at":1,"autoCount":0}' }))
        .attempt,
    ).toBeNull();
  });

  it("lagring som kastar (privat läge): inte användbar, ingen krasch", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readAttempt(throwing)).toEqual({ usable: false, attempt: null });
    expect(writeAttempt(throwing, { from: "A", to: "B", at: NOW, autoCount: 0 })).toBe(false);
    expect(readAttempt(null)).toEqual({ usable: false, attempt: null });
    expect(writeAttempt(undefined, { from: "A", to: "B", at: NOW, autoCount: 0 })).toBe(false);
  });
});
