import { describe, expect, it } from "vitest";

import { changedField, hasUnsavedInput, isTypingIn, setUnsavedInput } from "./unsaved-input";

/** Ett litet dokument utan webbläsare: bara det hasUnsavedInput läser. */
function fakeDocument({
  active = null,
  dialogOpen = false,
  fields = [],
}: {
  active?: object | null;
  dialogOpen?: boolean;
  fields?: object[];
} = {}): Document {
  return {
    activeElement: active,
    querySelector: (sel: string) => (sel === "dialog[open]" && dialogOpen ? {} : null),
    querySelectorAll: () => fields,
  } as unknown as Document;
}

describe("osparad inmatning", () => {
  it("inget ifyllt: inget osparat", () => {
    expect(hasUnsavedInput(fakeDocument())).toBe(false);
  });

  it("Fyll på med ändrade antal (anmält): osparat", () => {
    setUnsavedInput("fyll-pa", true);
    try {
      expect(hasUnsavedInput(fakeDocument())).toBe(true);
    } finally {
      setUnsavedInput("fyll-pa", false);
    }
    expect(hasUnsavedInput(fakeDocument())).toBe(false);
  });

  it("två anmälningar: osparat tills båda är borta", () => {
    setUnsavedInput("a", true);
    setUnsavedInput("b", true);
    setUnsavedInput("a", false);
    expect(hasUnsavedInput(fakeDocument())).toBe(true);
    setUnsavedInput("b", false);
    expect(hasUnsavedInput(fakeDocument())).toBe(false);
  });

  it("någon skriver i ett fält: osparat", () => {
    expect(hasUnsavedInput(fakeDocument({ active: { tagName: "INPUT", type: "number" } }))).toBe(
      true,
    );
    expect(hasUnsavedInput(fakeDocument({ active: { tagName: "BUTTON" } }))).toBe(false);
  });

  it("en öppen dialog: osparat", () => {
    expect(hasUnsavedInput(fakeDocument({ dialogOpen: true }))).toBe(true);
  });

  it("ändrat formulärfält: osparat", () => {
    const field = { tagName: "INPUT", type: "text", value: "ny", defaultValue: "gammal" };
    expect(hasUnsavedInput(fakeDocument({ fields: [field] }))).toBe(true);
    const same = { tagName: "INPUT", type: "text", value: "x", defaultValue: "x" };
    expect(hasUnsavedInput(fakeDocument({ fields: [same] }))).toBe(false);
  });
});

describe("isTypingIn", () => {
  it.each([
    [{ tagName: "INPUT", type: "text" }, true],
    [{ tagName: "INPUT" }, true],
    [{ tagName: "INPUT", type: "number" }, true],
    [{ tagName: "TEXTAREA" }, true],
    [{ tagName: "SELECT" }, true],
    [{ tagName: "DIV", isContentEditable: true }, true],
    [{ tagName: "INPUT", type: "checkbox" }, false],
    [{ tagName: "INPUT", type: "submit" }, false],
    [{ tagName: "INPUT", type: "text", readOnly: true }, false],
    [{ tagName: "INPUT", type: "text", disabled: true }, false],
    [{ tagName: "BUTTON" }, false],
    [null, false],
  ])("%j → %s", (el, expected) => {
    expect(isTypingIn(el)).toBe(expected);
  });
});

describe("changedField", () => {
  it("kryssruta", () => {
    expect(
      changedField({ tagName: "INPUT", type: "checkbox", checked: true, defaultChecked: false }),
    ).toBe(true);
    expect(
      changedField({ tagName: "INPUT", type: "checkbox", checked: true, defaultChecked: true }),
    ).toBe(false);
  });
  it("lista: första alternativet utan förval räknas som oförändrat", () => {
    const options = [{ defaultSelected: false }, { defaultSelected: false }];
    expect(changedField({ tagName: "SELECT", selectedIndex: 0, options })).toBe(false);
    expect(changedField({ tagName: "SELECT", selectedIndex: 1, options })).toBe(true);
    const preset = [{ defaultSelected: false }, { defaultSelected: true }];
    expect(changedField({ tagName: "SELECT", selectedIndex: 1, options: preset })).toBe(false);
  });
  it("knappar och inaktiva fält räknas aldrig", () => {
    expect(changedField({ tagName: "INPUT", type: "hidden", value: "a", defaultValue: "b" })).toBe(
      false,
    );
    expect(
      changedField({ tagName: "TEXTAREA", disabled: true, value: "a", defaultValue: "b" }),
    ).toBe(false);
  });
});
