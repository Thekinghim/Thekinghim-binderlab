import { describe, expect, it } from "vitest";

import { factLine, needAction, runsOutText, stepsText, whyPackText } from "./steps";

const sp = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");

describe("needAction: mystery packs alltid i hela omgångar", () => {
  it("mystery pack: omgångar, inte pack", () => {
    const a = needAction({ own: true, needQty: 28, mysteryBatchSize: 14, home: 0 })!;
    expect(a).toMatchObject({ kind: "pack", qty: 2, unit: "omgångar", packs: 28, batches: 2 });
    expect(sp(a.text)).toBe("Packa 2 omgångar");
    expect(sp(needAction({ own: true, needQty: 14, mysteryBatchSize: 14 })!.text)).toBe(
      "Packa 1 omgång",
    );
    // Ett tal som inte är en hel omgång rundas uppåt: aldrig "Packa 9 st" för ett mystery pack.
    expect(sp(needAction({ own: true, needQty: 9, mysteryBatchSize: 14 })!.text)).toBe(
      "Packa 1 omgång",
    );
  });
  it("egen produkt utan omgång och vanlig titel: pack", () => {
    expect(sp(needAction({ own: true, needQty: 11 })!.text)).toBe("Packa 11 st");
    expect(sp(needAction({ own: false, needQty: 36, mysteryBatchSize: 14 })!.text)).toBe(
      "Beställ 36 st",
    );
  });
  it("inget behov: null; okänd plan: verbet utan antal", () => {
    expect(needAction({ own: true, needQty: 0, mysteryBatchSize: 14 })).toBeNull();
    expect(needAction({ own: false, needQty: null })).toMatchObject({ qty: null, text: "Beställ" });
  });
});

describe("stegen och raden under titeln", () => {
  it("under 0 och ska fyllas på: båda stegen", () => {
    const a = needAction({ own: true, needQty: 28, mysteryBatchSize: 14, home: -1 });
    expect(sp(stepsText(true, a))).toBe("1. Räkna om. 2. Packa 2 omgångar.");
    expect(stepsText(false, a)).toBeNull();
    expect(stepsText(true, null)).toBeNull();
  });
  it("0 hemma · 9 i automaten · slut om 3 dagar", () => {
    expect(sp(factLine({ home: 0, inMachines: 9, lastsDays: 3, machineCount: 1 }))).toBe(
      "0 hemma · 9 i automaten · slut om 3 dagar",
    );
    expect(sp(factLine({ home: -1, inMachines: 9, lastsDays: 1, machineCount: 3 }))).toBe(
      "−1 hemma · 9 i automaterna · slut om 1 dag",
    );
    expect(sp(factLine({ home: 0, inMachines: 0, lastsDays: null }))).toBe(
      "0 hemma · 0 i automaterna · slut nu",
    );
    expect(sp(factLine({ home: 4, inMachines: 2, lastsDays: null }))).toBe(
      "4 hemma · 2 i automaterna",
    );
    expect(runsOutText({ home: 2, inMachines: 0, lastsDays: 0 })).toBe("slut i dag");
  });
  it("varför det ska packas", () => {
    expect(whyPackText([])).toBeNull();
    expect(whyPackText([{ title: "Mystery Pack", home: 0 }])).toBe("Mystery Pack är slut hemma.");
    expect(sp(whyPackText([{ title: "Mystery Pack", home: 4, lastsDays: 3 }]))).toBe(
      "Mystery Pack tar slut om 3 dagar.",
    );
    expect(whyPackText([{ title: "Mystery Pack", home: 4 }])).toBe("Mystery Pack tar snart slut.");
    expect(
      sp(
        whyPackText([
          { title: "A", home: 0 },
          { title: "B", home: 3 },
        ]),
      ),
    ).toBe("1 titel är slut hemma, 1 tar snart slut.");
  });
});
