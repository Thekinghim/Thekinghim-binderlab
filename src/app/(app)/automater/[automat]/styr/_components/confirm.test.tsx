import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canConfirm, ConfirmBody, type PreviewView } from "./confirm";
import { intervalOk, reasonOk } from "./validate";

const base: PreviewView = {
  lines: ["BL-003: ett pack matas ut ur Fack A3."],
  warnings: [],
  blocking: null,
  confirm: null,
  typed: null,
};

describe("canConfirm", () => {
  it("utan förhandsvisning eller med hinder går det inte", () => {
    expect(canConfirm({ preview: null, checked: true, typed: "" })).toBe(false);
    expect(
      canConfirm({ preview: { ...base, blocking: "Offline" }, checked: true, typed: "" }),
    ).toBe(false);
    expect(canConfirm({ preview: base, checked: false, typed: "" })).toBe(true);
  });

  it("frågan måste kryssas i", () => {
    const p = { ...base, confirm: "Facket har 4 – byt ändå?" };
    expect(canConfirm({ preview: p, checked: false, typed: "" })).toBe(false);
    expect(canConfirm({ preview: p, checked: true, typed: "" })).toBe(true);
  });

  it("automatens kod måste skrivas", () => {
    const p = { ...base, typed: "BL-003" };
    expect(canConfirm({ preview: p, checked: false, typed: "" })).toBe(false);
    expect(canConfirm({ preview: p, checked: false, typed: "BL-002" })).toBe(false);
    expect(canConfirm({ preview: p, checked: false, typed: " bl-003" })).toBe(true);
  });

  it("egna fält (anledningen) spärrar", () => {
    const p = { ...base, typed: "BL-003" };
    expect(canConfirm({ preview: p, checked: false, typed: "BL-003", extraValid: false })).toBe(
      false,
    );
    expect(reasonOk("kort")).toBe(false);
    expect(reasonOk("Pack fastnade")).toBe(true);
  });

  it("intervall 5–300 s", () => {
    expect(intervalOk("5")).toBe(true);
    expect(intervalOk("300")).toBe(true);
    expect(intervalOk("4")).toBe(false);
    expect(intervalOk("301")).toBe(false);
    expect(intervalOk("1.5")).toBe(false);
  });
});

describe("ConfirmBody", () => {
  const noop = () => {};
  it("visar raderna, frågan och fältet för koden", () => {
    const html = renderToStaticMarkup(
      <ConfirmBody
        preview={{ ...base, confirm: "Byt ändå?", typed: "BL-003", warnings: ["Tomt fack."] }}
        loading={false}
        error={null}
        checked={false}
        onChecked={noop}
        typed=""
        onTyped={noop}
        typedVerb="mata ut"
      />,
    );
    expect(html).toContain("BL-003: ett pack matas ut ur Fack A3.");
    expect(html).toContain("Byt ändå?");
    expect(html).toContain("Skriv BL-003 för att mata ut.");
    expect(html).toContain("Tomt fack.");
  });

  it("ett hinder döljer frågan och kodfältet", () => {
    const html = renderToStaticMarkup(
      <ConfirmBody
        preview={{ ...base, blocking: "Automaten är offline.", typed: "BL-003", confirm: "Säker?" }}
        loading={false}
        error={null}
        checked={false}
        onChecked={noop}
        typed=""
        onTyped={noop}
      />,
    );
    expect(html).toContain("Automaten är offline.");
    expect(html).not.toContain("Skriv BL-003");
    expect(html).not.toContain("Säker?");
  });
});
