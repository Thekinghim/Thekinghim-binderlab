/**
 * En lång etikett ("Mystery pack: fylls bara när facket är tomt (14 st)") gjorde automatens
 * sida 418 px bred på en 375 px telefon: en "whitespace-normal" utifrån vann inte över
 * etikettens egen "whitespace-nowrap" (cn() slår bara ihop klassnamn). `wrap` väljer därför
 * radbrytningen i komponenten, och de två klasserna får aldrig stå samtidigt.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusTag } from "./status-tag";

const classesOf = (html: string) => (/class="([^"]*)"/.exec(html)?.[1] ?? "").split(/\s+/);

describe("StatusTag", () => {
  it("är en rad och 24 px hög som standard", () => {
    const c = classesOf(renderToStaticMarkup(createElement(StatusTag, { status: "ok" })));
    expect(c).toContain("whitespace-nowrap");
    expect(c).toContain("h-6");
    expect(c).not.toContain("whitespace-normal");
  });

  it("wrap: texten radbryts och etiketten blir aldrig bredare än sin kolumn", () => {
    const c = classesOf(
      renderToStaticMarkup(
        createElement(
          StatusTag,
          { status: "neutral", wrap: true },
          "Mystery pack: fylls bara när facket är tomt (14 st)",
        ),
      ),
    );
    expect(c).toContain("whitespace-normal");
    expect(c).toContain("max-w-full");
    expect(c).toContain("min-h-6");
    expect(c).not.toContain("whitespace-nowrap");
    expect(c).not.toContain("h-6");
  });
});
