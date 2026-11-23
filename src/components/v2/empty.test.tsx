import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Empty, EMPTY_PACKS_FALLBACK, emptyPacks } from "./empty";

describe("emptyPacks", () => {
  it("tar titlar med olika bild, i ordning", () => {
    expect(
      emptyPacks([
        "Mystery Pack",
        "Mystery Pack",
        "Okänd titel",
        "Surging Sparks",
        "Journey Together",
      ]),
    ).toEqual(["Surging Sparks", "Mystery Pack", "Journey Together"]);
  });
  it("för få titlar med bild ger reserven", () => {
    const fan = ["Prismatic Evolutions", "Surging Sparks", "Scarlet & Violet 151"];
    expect(emptyPacks(["Okänd"])).toEqual(fan);
    expect(emptyPacks([])).toEqual(fan);
    expect(EMPTY_PACKS_FALLBACK[0]).toBe("Surging Sparks");
  });
});

describe("Empty", () => {
  it("utan packs: som förut", () => {
    const html = renderToStaticMarkup(<Empty title="Inget här" />);
    expect(html).toContain("v2-empty");
    expect(html).not.toContain("v2-fan");
  });
  it("med packs: solfjäder, rad, bock och knapp", () => {
    const html = renderToStaticMarkup(
      <Empty
        packs={["Surging Sparks", "Journey Together"]}
        done
        title="Allt klart"
        action={<a href="/x">Gå</a>}
      />,
    );
    expect(html).toContain("v2-fan");
    expect(html).toContain("v2-empty-ok");
    expect(html).toContain("Allt klart");
    expect(html).toContain('href="/x"');
  });
});
