import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINUS, NBSP } from "@/lib/format";
import {
  changeGlyph,
  compareLabel,
  formatBytes,
  formatChange,
  peakCaption,
  renderReportText,
  type RecipientKind,
} from "./report-content";
import { renderReportEmail } from "./report-email";
import { sampleReportEmails } from "./sample";
import { EMAIL_COLOR, EMAIL_COLOR_TOKEN } from "./theme";

const kinds: RecipientKind[] = ["butik", "bokforing", "delagare"];

describe("renderReportEmail", () => {
  for (const kind of kinds) {
    describe(kind, () => {
      const props = sampleReportEmails[kind];
      const email = renderReportEmail(props);

      it("ger ämnesrad med period och sammanfattning", () => {
        expect(email.subject).toContain("oktober 2026");
        expect(email.subject).toContain(props.summary);
      });

      it("är ett komplett, ljust dokument", () => {
        expect(email.html.startsWith("<!doctype html>")).toBe(true);
        expect(email.html).toContain('<meta charset="utf-8">');
        expect(email.html).toContain('name="viewport"');
        expect(email.html).toContain('<meta name="color-scheme" content="light only">');
        expect(email.html).toContain('<meta name="supported-color-schemes" content="light only">');
        expect(email.html).toContain('lang="sv"');
      });

      it("innehåller dold förhandstext", () => {
        expect(email.preheader.length).toBeGreaterThan(10);
        expect(email.html).toContain(email.preheader);
        expect(email.html).toMatch(
          /<div style="display:none;max-height:0;overflow:hidden;mso-hide:all/,
        );
      });

      it("saknar SVG, klasser, externa stilmallar och bilder", () => {
        expect(email.html).not.toContain("<svg");
        expect(email.html).not.toContain("class=");
        expect(email.html).not.toMatch(/<link[^>]+stylesheet/);
        expect(email.html).not.toContain("<img");
        expect(email.html).not.toContain("<script");
        expect(email.html).not.toMatch(/url\(/);
      });

      it("har exakt ett <style>, och grundlayouten står inline", () => {
        expect(email.html.match(/<style>/g)).toHaveLength(1);
        expect(email.html).toContain("@media only screen and (min-width:621px)");
        expect(email.html).toContain("@media only screen and (max-width:400px)");
        // Gmail läser inte attributselektorerna: grundvärdena måste rymmas i 375 px.
        expect(email.html).toContain(`data-m="outer" style="padding:16px 8px 32px"`);
        expect(email.html).toMatch(/data-m="gutter" style="padding:\d+px 24px/);
      });

      it("ersätter Outlook-markörerna med villkorskommentarer", () => {
        expect(email.html).not.toContain("x-bl-mso");
        expect(email.html).toContain(
          '<!--[if mso]><table role="presentation" align="center" width="600"',
        );
        expect(email.html).toContain("<!--[if mso]></td></tr></table><![endif]-->");
      });

      it("är under Gmails gräns på 102 kB", () => {
        expect(new TextEncoder().encode(email.html).length).toBeLessThan(100_000);
      });

      it("har knapp, länk och avregistrering", () => {
        expect(email.html).toContain(`href="${props.reportUrl}"`);
        expect(email.html).toContain("Avregistrera");
        expect(email.html).toContain("Du får detta mejl eftersom");
      });

      it("har en textversion med samma innehåll", () => {
        expect(email.text).toBe(renderReportText(props));
        expect(email.text).toContain(`Hej ${props.recipientName},`);
        expect(email.text).toContain(props.summary);
        expect(email.text).toContain(props.reportUrl);
        expect(email.text).toContain("Avregistrera:");
        expect(email.text).not.toMatch(/<[a-z]/i);
      });
    });
  }

  it("visar inte marginal eller kostnader för butiken", () => {
    const { html, text } = renderReportEmail(sampleReportEmails.butik);
    for (const s of [html, text]) {
      expect(s).not.toMatch(/marginal/i);
      expect(s).not.toMatch(/varukostnad/i);
    }
  });

  it("ger bokhållaren verifikationsnummer, moms och bilagor", () => {
    const { html, text } = renderReportEmail(sampleReportEmails.bokforing);
    expect(html).toContain("V1041");
    expect(html).toContain("Provision butiker");
    expect(text).toContain("forsaljning-2026-10.csv");
    expect(text).toContain("3001 Försäljning varor");
  });

  it("ger delägaren resultat, kassaflöde och plan", () => {
    const { text } = renderReportEmail(sampleReportEmails.delagare);
    expect(text).toContain("RESULTAT");
    expect(text).toContain("KASSAFLÖDE");
    expect(text).toContain("PLAN FÖR NOVEMBER");
    expect(text).toContain("Obs: Under målet 35");
  });
});

describe("hjälpfunktioner", () => {
  it("formaterar förändring relativt och i procentenheter", () => {
    expect(formatChange({ value: 0.124 })).toBe(`+12,4${NBSP}%`);
    expect(formatChange({ value: -0.009, kind: "points" })).toBe(`${MINUS}0,9${NBSP}p.e.`);
    expect(formatChange({ value: 0.0004, kind: "points" })).toBe(`±0,0${NBSP}p.e.`);
  });

  it("sätter pil efter avrundat värde", () => {
    expect(changeGlyph({ value: 0.124 })).toBe("▲");
    expect(changeGlyph({ value: -0.009, kind: "points" })).toBe("▼");
    expect(changeGlyph({ value: 0.0004 })).toBe("");
  });

  it("jämför hela månader med föregående månad", () => {
    expect(compareLabel({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) })).toBe(
      "mot september",
    );
    expect(compareLabel({ start: new Date(2026, 0, 1), end: new Date(2026, 0, 31) })).toBe(
      "mot december",
    );
    expect(compareLabel({ start: new Date(2026, 9, 3), end: new Date(2026, 10, 1) })).toBe(
      "mot föregående period",
    );
  });

  it("formaterar filstorlek", () => {
    expect(formatBytes(214_000)).toBe(`214${NBSP}kB`);
    expect(formatBytes(1_240_000)).toBe(`1,2${NBSP}MB`);
    expect(formatBytes(512)).toBe(`512${NBSP}B`);
  });

  it("beskriver den markerade dagen i text", () => {
    const caption = peakCaption([
      { date: new Date(2026, 9, 23), value: 100 },
      { date: new Date(2026, 9, 24), value: 300, note: "släppdag" },
    ]);
    expect(caption).toBe(`Lördag 24${NBSP}okt. var högsta dagen: 300${NBSP}kr, släppdag.`);
  });
});

describe("färger", () => {
  it("speglar det ljusa temat i tokens.css", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../styles/tokens.css", import.meta.url)),
      "utf8",
    );
    const light = css.slice(css.indexOf('[data-theme="light"]'));
    const block = light.slice(0, light.indexOf("}"));
    for (const [key, token] of Object.entries(EMAIL_COLOR_TOKEN)) {
      const m = block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"));
      expect(m?.[1]?.toLowerCase(), token).toBe(EMAIL_COLOR[key as keyof typeof EMAIL_COLOR]);
    }
  });
});
