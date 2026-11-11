import { describe, expect, it, vi } from "vitest";

import { createScopedStore, type StoreStorage } from "./scoped-store";

interface Done {
  packs: number;
}

/** En flik: samma lagring överlever att sidan laddas om (ett nytt minne skapas). */
function tab(): StoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("scoped-store (bekräftelsen efter Klar i Fyll på)", () => {
  it("värdet ligger utanför komponenten: en ommonterad FillApp läser samma bekräftelse", () => {
    const store = createScopedStore<Done>();
    const done = { packs: 12 };
    // Första monteringen sparar; nästa montering (nytt rutt-träd efter router.refresh) läser.
    store.write("org:anna", done);
    expect(store.read("org:anna")).toBe(done);
    expect(store.read("org:anna")).toBe(done);
  });

  it("hör till en person: en annan inloggad ser det inte och kan inte ta bort det", () => {
    const store = createScopedStore<Done>();
    const done = { packs: 12 };
    store.write("org:anna", done);
    expect(store.read("org:bo")).toBeNull();
    store.write("org:bo", null);
    expect(store.read("org:anna")).toBe(done);
  });

  it("null tar bort (Stäng, Ångra) och ett nytt värde ersätter det förra", () => {
    const store = createScopedStore<Done>();
    store.write("org:anna", { packs: 12 });
    const next = { packs: 3 };
    store.write("org:anna", next);
    expect(store.read("org:anna")).toBe(next);
    store.write("org:anna", null);
    expect(store.read("org:anna")).toBeNull();
  });

  it("lyssnare får veta varje ändring och slutar få det efter avregistrering", () => {
    const store = createScopedStore<Done>();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.write("org:anna", { packs: 1 });
    store.write("org:anna", null);
    expect(listener).toHaveBeenCalledTimes(2);
    // Att ta bort något som inte finns ändrar ingenting.
    store.write("org:anna", null);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    store.write("org:anna", { packs: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("scoped-store med sessionStorage (sidan laddas om efter Klar)", () => {
  const options = (storage: StoreStorage, now: () => number) => ({
    key: "binderlab:fyll-klar",
    maxAgeMs: 30 * 60_000,
    storage: () => storage,
    now,
  });

  it("bekräftelsen överlever en omladdning av sidan (felet: den försvann)", () => {
    const flik = tab();
    let clock = 1_000_000;
    const before = createScopedStore<Done>(options(flik, () => clock));
    before.write("org:anna", { packs: 12 });
    // Next laddar om hela sidan: allt i minnet är borta, bara flikens lagring finns kvar.
    clock += 2_000;
    const after = createScopedStore<Done>(options(flik, () => clock));
    expect(after.read("org:anna")).toEqual({ packs: 12 });
    // Samma objekt vid varje läsning (useSyncExternalStore kräver en stabil ögonblicksbild).
    expect(after.read("org:anna")).toBe(after.read("org:anna"));
  });

  it("en annan inloggad i samma flik ser den inte efter omladdningen", () => {
    const flik = tab();
    createScopedStore<Done>(options(flik, () => 1)).write("org:anna", { packs: 12 });
    const after = createScopedStore<Done>(options(flik, () => 2));
    expect(after.read("org:bo")).toBeNull();
  });

  it("Stäng och Ångra tar bort den också ur lagringen", () => {
    const flik = tab();
    const store = createScopedStore<Done>(options(flik, () => 1));
    store.write("org:anna", { packs: 12 });
    expect(flik.data.size).toBe(1);
    store.write("org:anna", null);
    expect(flik.data.size).toBe(0);
    expect(createScopedStore<Done>(options(flik, () => 2)).read("org:anna")).toBeNull();
  });

  it("glöms efter en halvtimme (Ångra går inte längre)", () => {
    const flik = tab();
    let clock = 0;
    const store = createScopedStore<Done>(options(flik, () => clock));
    store.write("org:anna", { packs: 12 });
    clock = 29 * 60_000;
    expect(store.read("org:anna")).toEqual({ packs: 12 });
    clock = 31 * 60_000;
    expect(store.read("org:anna")).toBeNull();
    expect(createScopedStore<Done>(options(flik, () => clock)).read("org:anna")).toBeNull();
  });

  it("trasig eller avstängd lagring: värdet finns i minnet, inget kastas", () => {
    const flik = tab();
    flik.data.set("binderlab:fyll-klar", "{inte json");
    const broken = createScopedStore<Done>(options(flik, () => 1));
    expect(broken.read("org:anna")).toBeNull();
    const refusing: StoreStorage = {
      getItem: () => {
        throw new Error("avstängd");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("avstängd");
      },
    };
    const memory = createScopedStore<Done>(options(refusing, () => 1));
    memory.write("org:anna", { packs: 4 });
    expect(memory.read("org:anna")).toEqual({ packs: 4 });
    const none = createScopedStore<Done>({ key: "k", maxAgeMs: 1, storage: () => null });
    none.write("org:anna", { packs: 5 });
    expect(none.read("org:anna")).toEqual({ packs: 5 });
  });
});
