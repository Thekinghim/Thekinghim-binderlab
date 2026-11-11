import { describe, expect, it } from "vitest";

import { NBSP } from "@/lib/format";

import type { HomeTodo } from "./model";
import { homeTodoHeading, homeTodoLinkText, homeTodoPhone } from "./todo-phone";

const todo = (key: string, level: HomeTodo["level"], p: Partial<HomeTodo> = {}): HomeTodo => ({
  key,
  level,
  title: key,
  detail: "",
  href: "/att-gora",
  orgWide: false,
  ...p,
});

describe("Att göra på Hem i telefonen", () => {
  it("visar bara punkterna som gäller nu, och länken till alla", () => {
    const r = homeTodoPhone([todo("a", "now"), todo("b", "now"), todo("c", "soon")], 6);
    expect([...r.shownKeys]).toEqual(["a", "b"]);
    expect(r.linkText).toBe("Alla 6");
    expect(r.next).toBeNull();
    expect(r.emptyText).toBeNull();
  });

  it("inget gäller nu: 5 punkter snart ger raden Nästa med kronorna, inte Inget brådskande", () => {
    const todos = [
      todo("visit:m3", "soon", {
        title: "Åk till BL\u2011003 senast torsdag",
        href: "/att-gora#punkt-visit-m3",
        atStakeOre: 230_000,
      }),
      todo("b", "soon"),
      todo("c", "soon"),
    ];
    const r = homeTodoPhone(todos, 5);
    expect(r.shownKeys.size).toBe(0);
    expect(r.next).toEqual({
      key: "visit:m3",
      text: `Nästa: Åk till BL\u2011003 senast torsdag · 2${NBSP}300${NBSP}kr i risk`,
      href: "/att-gora#punkt-visit-m3",
    });
    expect(r.emptyText).toBeNull();
    expect(r.linkText).toBe("Alla 5");
    expect(homeTodoHeading(5, 803_400)).toBe(`Att göra · 5 · 8${NBSP}034${NBSP}kr i risk`);
  });

  it("nästa sak utan kronor i risk står utan belopp", () => {
    const r = homeTodoPhone([todo("Lägg in inköpspris för X", "later")], 1);
    expect(r.next?.text).toBe("Nästa: Lägg in inköpspris för X");
    expect(r.linkText).toBe("Öppna");
  });

  it("Öppna när alla punkter syns", () => {
    const r = homeTodoPhone([todo("a", "now"), todo("b", "now")], 2);
    expect(r.linkText).toBe("Öppna");
  });

  it("Inget brådskande bara när listan är tom", () => {
    expect(homeTodoPhone([], 0)).toMatchObject({ emptyText: "Inget brådskande.", next: null });
    expect(homeTodoPhone([todo("a", "later")], 1).emptyText).toBeNull();
    expect(homeTodoPhone([todo("a", "now")], 1).emptyText).toBeNull();
    expect(homeTodoHeading(0, 0)).toBe("Att göra · 0");
  });

  it("från md som förut", () => {
    expect(homeTodoLinkText(3, 6)).toBe("Alla 6");
    expect(homeTodoLinkText(3, 3)).toBe("Öppna");
  });
});
