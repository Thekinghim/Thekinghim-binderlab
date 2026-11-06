import { describe, expect, it } from "vitest";

import {
  carriedQuery,
  parseStoreShareView,
  readStoreShareParam,
  showStoreShare,
  STORE_SHARE_COOKIE,
  STORE_SHARE_HEADER,
  STORE_SHARE_PARAM,
  storeShareHint,
  storeShareViewOf,
  withStoreShareView,
} from "./period-state";

const sp = (q: string) => new URLSearchParams(q);

describe("vyknappen Visa butikernas andel (?andel=1 eller kakan)", () => {
  it("är av som standard och på bara med ?andel=1", () => {
    expect(STORE_SHARE_PARAM).toBe("andel");
    expect(parseStoreShareView(sp(""))).toBe(false);
    expect(parseStoreShareView(sp("andel=0"))).toBe(false);
    expect(parseStoreShareView(sp("andel=1"))).toBe(true);
    expect(parseStoreShareView({ andel: "1" })).toBe(true);
    expect(readStoreShareParam(sp("andel=0"))).toBe(false);
    expect(readStoreShareParam(sp(""))).toBeNull();
  });

  it("gäller på alla sidor via kakan, och URL:en går före kakan", () => {
    expect(STORE_SHARE_COOKIE).toBe("binderlab-andel");
    expect(STORE_SHARE_HEADER).toBe("x-binderlab-andel");
    expect(storeShareViewOf(sp(""), undefined)).toBe(false);
    expect(storeShareViewOf(sp(""), "1")).toBe(true);
    expect(storeShareViewOf(sp("andel=1"), undefined)).toBe(true);
    expect(storeShareViewOf(sp("andel=0"), "1")).toBe(false);
    expect(storeShareViewOf(sp(""), "0")).toBe(false);
  });

  it("sätter och tar bort parametern utan att röra resten", () => {
    expect(withStoreShareView(sp("period=7d"), true).toString()).toBe("period=7d&andel=1");
    expect(withStoreShareView(sp("period=7d&andel=1"), false).toString()).toBe("period=7d");
  });

  it("följer med mellan sidor, som Med VMB", () => {
    expect(carriedQuery(sp("period=allt&andel=1&sort=x"))).toBe("?period=allt&andel=1");
  });

  it("dras med knappen eller vald butik, inte av ett automatfilter", () => {
    expect(showStoreShare(sp("period=allt"))).toBe(false);
    expect(showStoreShare(sp("andel=1"))).toBe(true);
    expect(showStoreShare(sp("butik=s1"))).toBe(true);
    expect(showStoreShare(sp("automat=m1"))).toBe(false);
    // Serverns läge (kakan) går in som andra argument.
    expect(showStoreShare(sp("automat=m1"), true)).toBe(true);
  });

  it("säger vad vinsten är i läget", () => {
    expect(storeShareHint(false)).toBe("Före butikernas andel");
    expect(storeShareHint(true)).toBe("Efter butikernas andel");
  });
});
