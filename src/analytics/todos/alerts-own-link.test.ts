import { describe, expect, it } from "vitest";

import { alertLink, alertTodos } from "./alerts";
import type { AlertRef } from "./types";

const alert = (over: Partial<AlertRef>): AlertRef => ({
  id: "a1",
  key: "order_refund:s1:880460",
  kind: "order_attention",
  severity: "warning",
  machineId: null,
  titleId: null,
  title: "Order 880460 i BL-001 återbetalades i Awish",
  detail: "För in återbetalningen på ett ärende i Inkorg.",
  openedAt: "2026-11-19T10:00:00.000Z",
  acknowledged: false,
  link: "/inkorg/nytt?order=0b0e7a52-5b1c-4f4e-9d0a-2f3d7c1a9e11",
  ...over,
});

const ctx = (alerts: AlertRef[]) =>
  ({
    input: { alerts },
    nowMs: Date.parse("2026-11-19T12:00:00Z"),
  }) as unknown as Parameters<typeof alertTodos>[0];

describe("larm med egen länk i Att göra", () => {
  it("en order att hantera blir en punkt som leder till ärendet", () => {
    const [todo] = alertTodos(ctx([alert({})]));
    expect(todo?.title).toBe("Order 880460 i BL-001 återbetalades i Awish");
    expect(todo?.link).toBe("/inkorg/nytt?order=0b0e7a52-5b1c-4f4e-9d0a-2f3d7c1a9e11");
    expect(todo?.action?.label).toBe("Hantera ordern");
    expect(todo?.level).toBe("soon");
  });

  it("kvitterad: någon tar det, punkten står inte kvar i Att göra", () => {
    expect(alertTodos(ctx([alert({ acknowledged: true })]))).toEqual([]);
  });

  it("vaktens larm leder dit felet åtgärdas, inte till en automat", () => {
    const watch = alert({
      key: "watch:kontroll",
      kind: "job_failed",
      severity: "critical",
      title: "Kontrollen har inte körts sedan 17 nov. 05:37",
      link: "/installningar/kontroll",
    });
    const [todo] = alertTodos(ctx([watch]));
    expect(todo?.link).toBe("/installningar/kontroll");
    expect(todo?.action?.label).toBe("Öppna");
    expect(todo?.level).toBe("now");
  });

  it("en länk utanför appen används aldrig", () => {
    expect(alertLink(alert({ kind: "job_failed", link: "//evil.example" }))).toBe("/drift#larm");
    expect(alertLink(alert({ kind: "job_failed", link: null }))).toBe("/drift#larm");
    // Andra larmtyper följer sin egen regel, oavsett länk.
    expect(alertLink(alert({ kind: "import_failed", link: "/inkorg" }))).toBe("/datakallor");
  });
});
