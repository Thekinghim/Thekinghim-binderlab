/** De visuella byggstenarna ritade till HTML: rätt struktur, tillgänglighet och inga belopp själva. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MachineThumb } from "./machine-thumb";
import { PackFan, PackPodium, PackStack } from "./pack-visuals";
import { ProfitBar } from "./profit-bar";
import { ProgressRing } from "./progress-ring";
import { StoreFace } from "./store-face";

describe("ProgressRing", () => {
  it("har en textbeskrivning, procent i mitten och alla tre delarna", () => {
    const html = renderToStaticMarkup(
      <ProgressRing
        value={36920}
        goal={50000}
        pace={38333}
        forecast={48160}
        label="74 procent av målet"
        caption="av 50 000 kr"
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="74 procent av målet"');
    expect(html).toContain("74 %");
    expect(html).toContain("av 50 000 kr");
    expect(html).toContain("v2-ring-res");
    expect(html).toContain("v2-ring-fc");
    expect(html).toContain("v2-ring-pace");
  });

  it("utan caption visas inget belopp (påfyllare och demokund)", () => {
    const html = renderToStaticMarkup(<ProgressRing value={10} goal={20} label="Halvvägs" />);
    expect(html).not.toContain("kr");
    expect(html).toContain("50 %");
  });
});

describe("ProfitBar", () => {
  it("visar marginalen med decimalkomma", () => {
    const html = renderToStaticMarkup(<ProfitBar revenue={21000} cost={13000} max={21000} />);
    expect(html).toContain("38,1 %");
    expect(html).toContain('class="cost" style="width:61.9%"');
    expect(html).toContain('class="prof"');
  });

  it("okänt inköp: randig stapel och 'vinst okänd'", () => {
    const html = renderToStaticMarkup(<ProfitBar revenue={8383} cost={null} max={22000} />);
    expect(html).toContain('class="hatch"');
    expect(html).toContain("vinst okänd");
    expect(html).not.toContain('class="cost"');
  });
});

describe("StoreFace", () => {
  it("ritar symbolen för typen i stadens färg, dold för skärmläsare", () => {
    const html = renderToStaticMarkup(
      <StoreFace name="Bio Fyren" storeType="Biograf" city="Enköping" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-glyph="reel"');
    expect(html).toMatch(/--sf-bg:#[0-9a-f]{6}/);
  });

  it("initialer när typen saknas", () => {
    const html = renderToStaticMarkup(<StoreFace name="Köpcentrum Kvarnhagen" size="lg" />);
    expect(html).toContain(">KK<");
    expect(html).toContain("v2-sface lg");
  });
});

describe("PackStack, PackPodium, PackFan", () => {
  it("högen får kopior efter antalet hemma", () => {
    const html = renderToStaticMarkup(<PackStack title="Prismatic Evolutions" count={144} />);
    expect(html.match(/v2-pstack-cp/g)).toHaveLength(3);
  });

  it("pallen visar 2, 1, 3 men läses i placeringsordning", () => {
    const html = renderToStaticMarkup(
      <PackPodium
        items={[
          { title: "Prismatic Evolutions", label: "112 st" },
          { title: "Mega Evolution", label: "100 st" },
          { title: "Surging Sparks", label: "77 st" },
        ]}
      />,
    );
    const order = [...html.matchAll(/v2-pod-i p(\d)/g)].map((m) => m[1]);
    expect(order).toEqual(["2", "1", "3"]);
    expect(html).toContain("1. Prismatic Evolutions");
    expect(html).toContain('value="1"');
  });

  it("pallen klarar färre än tre", () => {
    const html = renderToStaticMarkup(
      <PackPodium items={[{ title: "Okänd titel", label: "3 st" }]} />,
    );
    expect([...html.matchAll(/v2-pod-i p(\d)/g)].map((m) => m[1])).toEqual(["1"]);
  });

  it("solfjädern ritar högst fem och hoppar över tomma titlar", () => {
    const titles = [
      "Prismatic Evolutions",
      "",
      null,
      "Mega Evolution",
      "Surging Sparks",
      "Destined Rivals",
      "Temporal Forces",
      "Black Bolt",
    ];
    const html = renderToStaticMarkup(<PackFan titles={titles} />);
    expect(html.match(/class="v2-fan-i"/g)).toHaveLength(5);
    expect(renderToStaticMarkup(<PackFan titles={[]} />)).toBe("");
  });
});

describe("MachineThumb", () => {
  it("är den riktiga automaten, dold för skärmläsare, i vald storlek", () => {
    const html = renderToStaticMarkup(<MachineThumb machineId="m1" size="xs" />);
    expect(html).toContain('class="v2-mthumb xs"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="v2-mglyph"');
    expect(html).not.toContain("<title>");
    expect(html).not.toContain('role="img"');
  });

  it("är svart med stjärnor utan utseende och gul med look=gul", () => {
    expect(renderToStaticMarkup(<MachineThumb size="sm" />)).toContain('data-look="stjarnor"');
    expect(renderToStaticMarkup(<MachineThumb size="sm" look={null} />)).toContain(
      'data-look="stjarnor"',
    );
    const gul = renderToStaticMarkup(<MachineThumb size="sm" look="gul" />);
    expect(gul).toContain('data-look="gul"');
    expect(gul).not.toContain('data-look="stjarnor"');
  });

  it("väljer bildens detaljnivå efter storleken (inga packbilder i små)", () => {
    const sizes = { xs: "xs", sm: "s", md: "s", lg: "m" } as const;
    for (const [thumb, glyph] of Object.entries(sizes)) {
      const html = renderToStaticMarkup(
        <MachineThumb size={thumb as keyof typeof sizes} look="gul" />,
      );
      expect(html).toContain(`data-size="${glyph}"`);
      expect(html).not.toContain("<image");
    }
  });
});
