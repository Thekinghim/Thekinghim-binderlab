import { describe, expect, it } from "vitest";

import { splitHeadNumber } from "./head-number";

describe("splitHeadNumber", () => {
  it("första heltalet, även med tusentalsavgränsare", () => {
    expect(splitHeadNumber("1 240 pack i lager.")).toEqual({
      before: "",
      value: 1240,
      after: " pack i lager.",
    });
    expect(splitHeadNumber("Beställ 3 titlar för ca 1 100 kr.")).toEqual({
      before: "Beställ ",
      value: 3,
      after: " titlar för ca 1 100 kr.",
    });
    expect(splitHeadNumber("Ca 18 000 kr kommande 4 veckor.").value).toBe(18000);
  });

  it("utan tal: hela texten", () => {
    expect(splitHeadNumber("Inget att beställa.")).toEqual({
      before: "Inget att beställa.",
      value: null,
      after: "",
    });
  });

  it("delarna blir alltid samma text igen", () => {
    for (const t of ["Packa 24 st Mystery Pack.", "Prognosen missade 12 % per dag.", "0 pack."]) {
      const h = splitHeadNumber(t);
      expect(`${h.before}${h.value ?? ""}${h.after}`.replace(/\s/g, "")).toBe(t.replace(/\s/g, ""));
    }
  });
});
