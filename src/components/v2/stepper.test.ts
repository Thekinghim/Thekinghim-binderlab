import { describe, expect, it } from "vitest";

import { stepperDraft } from "./stepper";

describe("stegarens sifferfält", () => {
  it("tomt fält ändrar inget medan man skriver", () => {
    expect(stepperDraft("", 0, 20)).toEqual({ draft: "", value: null });
  });

  it("tar bort inledande nollor och annat än siffror", () => {
    expect(stepperDraft("05", 0, 20)).toEqual({ draft: "5", value: 5 });
    expect(stepperDraft("0", 0, 20)).toEqual({ draft: "0", value: 0 });
    expect(stepperDraft("1-2", 0, 20)).toEqual({ draft: "12", value: 12 });
  });

  it("ett tal över max blir max, under min blir min", () => {
    expect(stepperDraft("99", 0, 20)).toEqual({ draft: "20", value: 20 });
    expect(stepperDraft("0", 1, 20)).toEqual({ draft: "1", value: 1 });
  });
});
