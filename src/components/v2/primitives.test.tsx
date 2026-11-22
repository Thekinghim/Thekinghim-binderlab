/**
 * V2-byggstenarna för de gamla sidorna (Table, Field, Notice, KeyValues, Section): rätt
 * semantik (caption, scope, label↔fält, aria-describedby) och V2-klasserna sidorna stylas med.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Field, Input } from "./field";
import { KeyValues } from "./key-values";
import { Notice } from "./notice";
import { Section } from "./section";
import { Table } from "./table";

type Row = { id: string; name: string; kr: string };
const columns = [
  { key: "name", header: "Butik", cell: (r: Row) => r.name },
  { key: "kr", header: "Vinst", align: "right" as const, cell: (r: Row) => r.kr },
  { key: "x", header: "Stad", hideOnPhone: true, cell: () => "Göteborg" },
];

describe("Table", () => {
  it("ritar caption, kolumnrubriker med scope och högerställda tal", () => {
    const html = renderToStaticMarkup(
      <Table
        caption="Vinst per butik"
        rows={[{ id: "a", name: "Lerum", kr: "1 200 kr" }]}
        rowKey={(r) => r.id}
        columns={columns}
      />,
    );
    expect(html).toContain('<caption class="sr-only">Vinst per butik</caption>');
    expect(html).toContain('<th scope="col">Butik</th>');
    expect(html).toContain('<th scope="col" class="num">Vinst</th>');
    expect(html).toContain('<td class="num">1 200 kr</td>');
    expect(html).toContain('class="ph-hide"');
    expect(html).toContain('class="v2-table"');
  });

  it("visar tomtexten över alla kolumner när det inte finns rader", () => {
    const html = renderToStaticMarkup(
      <Table caption="T" rows={[]} rowKey={(r: Row) => r.id} columns={columns} empty="Inga." />,
    );
    expect(html).toMatch(/<td colspan="3" class="none">Inga\.<\/td>/i);
  });

  it("länkar raden från första cellen", () => {
    const html = renderToStaticMarkup(
      <Table
        caption="T"
        rows={[{ id: "a", name: "Lerum", kr: "1" }]}
        rowKey={(r) => r.id}
        columns={columns}
        onRowHref={(r) => `/butiker/${r.id}`}
      />,
    );
    expect(html).toContain('<tr class="lnk">');
    expect(html).toContain('href="/butiker/a"');
  });
});

describe("Field", () => {
  it("kopplar etikett, fält och fel", () => {
    const html = renderToStaticMarkup(
      <Field label="Kortavgift" error="Ange ett tal." id="fee">
        {(p) => <Input {...p} suffix="%" />}
      </Field>,
    );
    expect(html).toContain('<label for="fee">Kortavgift</label>');
    expect(html).toContain('id="fee"');
    expect(html).toContain('aria-describedby="fee-msg"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('<p id="fee-msg" class="err">Ange ett tal.</p>');
    expect(html).toContain('class="sfx"');
  });

  it("utan fel: hjälptexten beskriver fältet och fältet är inte ogiltigt", () => {
    const html = renderToStaticMarkup(
      <Field label="Namn" hint="Som på kvittot" id="n">
        {(p) => <Input {...p} />}
      </Field>,
    );
    expect(html).toContain('<p id="n-msg" class="hint">Som på kvittot</p>');
    expect(html).not.toContain("aria-invalid");
  });
});

describe("Notice, KeyValues, Section", () => {
  it("Notice bär tonen som klass och är bara levande på begäran", () => {
    const quiet = renderToStaticMarkup(<Notice tone="warning" title="Kortavgiften står på 0 %." />);
    expect(quiet).toContain('class="v2-notice warning"');
    expect(quiet).not.toContain("role=");
    const live = renderToStaticMarkup(<Notice tone="critical" live title="Fel" />);
    expect(live).toContain('role="alert"');
  });

  it("KeyValues är en dl med dt/dd", () => {
    const html = renderToStaticMarkup(<KeyValues items={[{ label: "I dag", value: 2 }]} />);
    expect(html).toBe('<dl class="v2-kv"><div><dt>I dag</dt><dd>2</dd></div></dl>');
  });

  it("Section har rubrik, rad under och åtgärder", () => {
    const html = renderToStaticMarkup(
      <Section title="Avtal" sub="3 butiker" actions={<button type="button">Nytt</button>}>
        <p>innehåll</p>
      </Section>,
    );
    expect(html).toContain("<h2>Avtal</h2>");
    expect(html).toContain("<p>3 butiker</p>");
    expect(html).toContain('<div class="acts">');
  });
});
