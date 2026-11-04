import { describe, expect, it } from "vitest";

import type { HomeTodo } from "./model";
import { homeTodoLinkText, homeTodoPhone } from "./todo-phone";

const todo = (key: string, level: HomeTodo["level"]): HomeTodo => ({
  key,
  level,
  title: key,
  detail: "",
  href: "/att-gora",
  orgWide: false,
});

describe("Att göra på Hem i telefonen", () => {
  it("visar bara punkterna som gäller nu, och länken till alla", () => {
    const r = homeTodoPhone([todo("a", "now"), todo("b", "now"), todo("c", "soon")], 6);
    expect([...r.shownKeys]).toEqual(["a", "b"]);
    expect(r.linkText).toBe("Alla 6");
    expect(r.emptyText).toBeNull();
  });

  it("säger Inget brådskande när inget gäller nu", () => {
    const r = homeTodoPhone([todo("a", "soon"), todo("b", "later")], 2);
    expect(r.shownKeys.size).toBe(0);
    expect(r.emptyText).toBe("Inget brådskande.");
    expect(r.linkText).toBe("Alla 2");
  });

  it("Öppna när alla punkter syns", () => {
    const r = homeTodoPhone([todo("a", "now"), todo("b", "now")], 2);
    expect(r.linkText).toBe("Öppna");
  });

  it("utan punkter: ingen rad (Hem visar Inget att göra just nu)", () => {
    expect(homeTodoPhone([], 0).emptyText).toBeNull();
  });

  it("från md som förut", () => {
    expect(homeTodoLinkText(3, 6)).toBe("Alla 6");
    expect(homeTodoLinkText(3, 3)).toBe("Öppna");
  });
});
