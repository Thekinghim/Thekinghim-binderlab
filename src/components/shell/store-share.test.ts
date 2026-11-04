import { describe, expect, it } from "vitest";

import {
  carriedQuery,
  parseStoreShareView,
  showStoreShare,
  STORE_SHARE_PARAM,
  withStoreShareView,
} from "./period-state";
import { storeShareStorageKey } from "./use-period";

const sp = (q: string) => new URLSearchParams(q);

describe("vyknappen Visa butikernas andel (?andel=1)", () => {
  it("är av som standard och på bara med ?andel=1", () => {
    expect(STORE_SHARE_PARAM).toBe("andel");
    expect(parseStoreShareView(sp(""))).toBe(false);
    expect(parseStoreShareView(sp("andel=0"))).toBe(false);
    expect(parseStoreShareView(sp("andel=1"))).toBe(true);
    expect(parseStoreShareView({ andel: "1" })).toBe(true);
  });

  it("sätter och tar bort parametern utan att röra resten", () => {
    expect(withStoreShareView(sp("period=7d"), true).toString()).toBe("period=7d&andel=1");
    expect(withStoreShareView(sp("period=7d&andel=1"), false).toString()).toBe("period=7d");
  });

  it("följer med mellan sidor, som Med VMB", () => {
    expect(carriedQuery(sp("period=allt&andel=1&sort=x"))).toBe("?period=allt&andel=1");
  });

  it("visas alltid med vald butik eller automat, annars bara med knappen", () => {
    expect(showStoreShare(sp("period=allt"))).toBe(false);
    expect(showStoreShare(sp("andel=1"))).toBe(true);
    expect(showStoreShare(sp("butik=s1"))).toBe(true);
    expect(showStoreShare(sp("automat=m1"))).toBe(true);
  });

  it("minns valet per användare, skilt från Med VMB", () => {
    expect(storeShareStorageKey("u1")).toBe("binderlab:andel:u1");
  });
});
