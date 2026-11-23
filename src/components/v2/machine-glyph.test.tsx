import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { machineLookOf } from "@/lib/machine-look";

import { MachineGlyph } from "./machine-glyph";
import {
  cellOf,
  glyphAriaLabel,
  glyphStatusOf,
  glyphWidth,
  screenGrid,
  slotsFromFill,
  type GlyphSlot,
} from "./machine-glyph-model";

const slot = (title: string, fill: number | null, empty = false): GlyphSlot => ({
  title,
  fill,
  empty,
});

describe("glyphStatusOf", () => {
  it("mappar flottans läge till bildens", () => {
    expect(glyphStatusOf("offline")).toBe("offline");
    expect(glyphStatusOf("tom")).toBe("empty");
    expect(glyphStatusOf("fyll-pa")).toBe("refill");
    for (const s of ["startklar", "strom-av", "tom-snart", "i-drift"] as const) {
      expect(glyphStatusOf(s)).toBe("ok");
    }
  });
});

describe("cellOf", () => {
  it("klämmer fyllnaden och sätter ton", () => {
    expect(cellOf(slot("A", 1.4))).toMatchObject({ fill: 1, empty: false, tone: "ok" });
    expect(cellOf(slot("A", 0.25))).toMatchObject({ tone: "low" });
    expect(cellOf(slot("A", 0.26))).toMatchObject({ tone: "ok" });
    expect(cellOf(slot("A", null))).toMatchObject({ fill: null, tone: "unknown" });
  });
  it("0 % eller tomt fack = tom", () => {
    expect(cellOf(slot("A", 0))).toMatchObject({ empty: true, tone: "empty", fill: 0 });
    expect(cellOf(slot("A", 0.6, true))).toMatchObject({ empty: true, tone: "empty", fill: 0 });
    expect(cellOf(slot("A", -2))).toMatchObject({ empty: true });
  });
});

describe("slotsFromFill", () => {
  const names = new Map([
    ["t1", "Prismatic Evolutions"],
    ["t2", "Black Bolt"],
  ]);
  it("räknar fyllnad per titel och markerar tomma fack", () => {
    const out = slotsFromFill(
      [
        { title_id: "t1", units: 6, capacity: 12, channels: 2, empty: 0 },
        { title_id: "t2", units: 3, capacity: 12, channels: 2, empty: 1 },
        { title_id: "okänd", units: 3, capacity: 3, channels: 1, empty: 0 },
      ],
      (id) => names.get(id),
    );
    expect(out).toEqual([
      { title: "Prismatic Evolutions", fill: 0.5, empty: false },
      { title: "Black Bolt", fill: 0.25, empty: true },
    ]);
  });
  it("kapacitet 0 = okänd fyllnad, inga pack = tom", () => {
    expect(
      slotsFromFill([{ title_id: "t1", units: 0, capacity: 0, channels: 1, empty: 0 }], (id) =>
        names.get(id),
      ),
    ).toEqual([{ title: "Prismatic Evolutions", fill: null, empty: true }]);
    expect(slotsFromFill(null, () => "x")).toEqual([]);
  });
});

describe("screenGrid", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => slot(`T${i}`, 0.5));
  it("inga packbilder i xs och s", () => {
    expect(screenGrid("xs", many(4)).cells).toHaveLength(0);
    expect(screenGrid("s", many(4)).cells).toHaveLength(0);
  });
  it("två kolumner för få fack", () => {
    const g = screenGrid("xl", many(3));
    expect(g).toMatchObject({ cols: 2, rows: 2, more: 0 });
    expect(g.cells).toHaveLength(3);
  });
  it("tre kolumner i xl när fler än fyra", () => {
    expect(screenGrid("xl", many(7))).toMatchObject({ cols: 3, rows: 3, more: 0 });
  });
  it("sista rutan blir +N när alla inte får plats", () => {
    const m = screenGrid("m", many(6));
    expect(m).toMatchObject({ cols: 2, rows: 2, more: 3 });
    expect(m.cells).toHaveLength(3);
    const l = screenGrid("l", many(6));
    expect(l).toMatchObject({ cols: 2, rows: 3, more: 0 });
    expect(screenGrid("xl", many(20))).toMatchObject({ cols: 3, rows: 4, more: 9 });
  });
});

describe("glyphAriaLabel", () => {
  it("säger utseende, läge och tomma titlar på svenska", () => {
    expect(glyphAriaLabel({ look: "stjarnor", status: "ok" })).toBe(
      "Svart automat med stjärnor. I drift.",
    );
    expect(
      glyphAriaLabel({
        look: "gul",
        status: "refill",
        name: "BL-001",
        slots: [slot("A", 0.5), slot("B", 0, true), slot("C", 0)],
      }),
    ).toBe("BL-001, gul automat. Behöver fyllas på. 3 titlar, 2 tomma.");
    expect(glyphAriaLabel({ look: "gul", status: "offline", slots: [slot("A", 0)] })).toBe(
      "Gul automat. Offline.",
    );
  });
});

describe("machineLookOf", () => {
  it("null och okänt = svart med stjärnor", () => {
    expect(machineLookOf(null)).toBe("stjarnor");
    expect(machineLookOf("lila")).toBe("stjarnor");
    expect(machineLookOf("gul")).toBe("gul");
  });
});

describe("MachineGlyph", () => {
  it("ritar rätt storlek med svensk etikett", () => {
    const html = renderToStaticMarkup(
      <MachineGlyph look="gul" size="l" status="empty" name="BL-001" />,
    );
    expect(html).toContain(`height="160"`);
    expect(html).toContain(`width="${glyphWidth("l")}"`);
    expect(html).toContain('aria-label="BL-001, gul automat. Tom."');
    expect(html).toContain('data-look="gul"');
  });
  it("packbilder bara från m och aldrig när den är offline", () => {
    const slots = [slot("Prismatic Evolutions", 0.8)];
    expect(renderToStaticMarkup(<MachineGlyph size="s" slots={slots} />)).not.toContain("/packs/");
    expect(renderToStaticMarkup(<MachineGlyph size="m" slots={slots} />)).toContain(
      "/packs/prismatic-evolutions.webp",
    );
    expect(
      renderToStaticMarkup(<MachineGlyph size="xl" status="offline" slots={slots} />),
    ).not.toContain("/packs/");
  });
  it("dekorativ = dold för skärmläsare", () => {
    const html = renderToStaticMarkup(<MachineGlyph size="xs" decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("aria-label");
  });
});
