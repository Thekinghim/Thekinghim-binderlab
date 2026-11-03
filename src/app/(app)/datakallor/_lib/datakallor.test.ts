import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES } from "@/import/csv-table";
import { FIELD_LABELS, IMPORT_FIELDS, REQUIRED_FIELDS } from "@/import/mapping";
import type { ImportRowResult } from "@/import/pipeline";

import {
  MAPPING_FIELD_LABELS,
  MAPPING_FIELDS,
  MAX_UPLOAD_BYTES,
  REQUIRED_MAPPING_FIELDS,
} from "./constants";
import { formatBytes, formatIsoDay, formatWhen, formatWhenWithYear, notNewParts } from "./display";
import { headlineOf } from "./headline";
import { localizeWarnings, previewMapping, selectPreviewRows } from "./preview";
import { parseRowFilter } from "./schemas";
import { suggestMachine } from "./suggest";
import type { DatakallorData, SourceView } from "./types";

/** Hårda mellanslag (U+00A0) → vanliga, för läsbara förväntningar. */
const sp = (s: string | undefined) => (s ?? "").replace(/\u00a0/g, " ");

function row(n: number, status: ImportRowResult["status"]): ImportRowResult {
  return {
    rowNumber: n,
    status,
    externalId: String(n),
    rawTitle: "T",
    titleId: null,
    titleKnown: true,
    machineName: "M",
    machineMapped: true,
    amountOre: 17000,
    paymentMethod: null,
    orderedAt: "2026-11-01T16:17:00.000Z",
    orderedAtLocal: null,
    businessDate: "2026-11-01",
    lateInClosedPeriod: false,
    orderId: null,
    message: null,
    notes: [],
  };
}

describe("konstanterna stämmer med importen", () => {
  it("fält, etiketter, obligatoriska fält och maxstorlek", () => {
    expect([...MAPPING_FIELDS]).toEqual([...IMPORT_FIELDS]);
    expect(MAPPING_FIELD_LABELS).toEqual(FIELD_LABELS);
    expect([...REQUIRED_MAPPING_FIELDS]).toEqual([...REQUIRED_FIELDS]);
    expect(MAX_UPLOAD_BYTES).toBe(MAX_FILE_BYTES);
  });
});

describe("selectPreviewRows", () => {
  it("tar de första raderna och alla problemrader upp till gränsen, i filens ordning", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i + 2, "new")),
      row(7, "error"),
      row(8, "duplicate"),
      row(9, "conflict"),
      row(10, "error"),
    ];
    const picked = selectPreviewRows(rows, 3, 2);
    expect(picked.rows.map((r) => r.rowNumber)).toEqual([2, 3, 4, 7, 9]);
    expect(picked.hidden).toBe(4);
  });

  it("problemrader bland de första räknas mot gränsen", () => {
    const rows = [row(2, "error"), row(3, "new"), row(4, "error"), row(5, "error")];
    expect(selectPreviewRows(rows, 2, 2).rows.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
  });
});

describe("previewMapping", () => {
  it("läser adapterns mappning och fyller saknade fält", () => {
    const m = previewMapping({
      columns: { externalId: "Order No.", title: "Name" },
      source: { externalId: "saved" },
      headers: ["Order No.", "Name", 3],
      delimiter: ";",
      encoding: "utf-8",
    });
    expect(m?.columns.externalId).toBe("Order No.");
    expect(m?.columns.machine).toBeNull();
    expect(m?.source.externalId).toBe("saved");
    expect(m?.source.title).toBe("auto");
    expect(m?.source.machine).toBe("none");
    expect(m?.headers).toEqual(["Order No.", "Name"]);
    expect(m?.delimiter).toBe(";");
  });

  it("null för något som inte är en mappning", () => {
    expect(previewMapping(null)).toBeNull();
    expect(previewMapping({ columns: [] })).toBeNull();
  });
});

describe("suggestMachine", () => {
  const machines = [
    { id: "a", code: "BL-001", name: "Centrum" },
    { id: "b", code: "BL-0011", name: "Hamnen" },
    { id: "c", code: "BL-002", name: "Gallerian" },
  ];

  it("koden som eget ord i Awish-namnet", () => {
    expect(suggestMachine("BL-001 Centrum", machines)).toBe("a");
    expect(suggestMachine("bl-0011 hamnen", machines)).toBe("b");
    expect(suggestMachine("Automat BL-002 (nytt namn)", machines)).toBe("c");
  });

  it("namnet exakt, annars inget förslag", () => {
    expect(suggestMachine("Gallerian", machines)).toBe("c");
    expect(suggestMachine("ICA Lund", machines)).toBeNull();
    expect(suggestMachine(null, machines)).toBeNull();
  });
});

describe("visning", () => {
  it("tider i organisationens tidszon", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(sp(formatWhen("2026-11-01T20:23:00Z", "Europe/Stockholm", now))).toBe("1 nov. 21:23");
    expect(sp(formatWhenWithYear("2026-11-01T16:17:00Z", "Europe/Stockholm"))).toBe(
      "1 nov. 2026 17:17",
    );
    expect(sp(formatWhen(null, "Europe/Stockholm"))).toBe("–");
  });

  it("filstorlek", () => {
    expect(sp(formatBytes(840))).toBe("840 B");
    expect(sp(formatBytes(61_391))).toBe("61 kB");
    expect(sp(formatBytes(10_308_985))).toBe("10,3 MB");
  });

  it("radfilter ur URL:en", () => {
    expect(parseRowFilter("fel")).toBe("fel");
    expect(parseRowFilter(["nya"])).toBe("nya");
    expect(parseRowFilter("<script>")).toBe("problem");
    expect(parseRowFilter(undefined)).toBe("problem");
  });
});

describe("headlineOf", () => {
  const source: SourceView = {
    id: "s",
    name: "Awish",
    provider: "awish_csv",
    sourceTimezone: "Asia/Shanghai",
    status: "active",
    lastSyncedAt: "2026-11-01T20:23:00Z",
    latestOrderAt: "2026-11-01T16:17:00Z",
    archived: false,
    acceptsFiles: true,
    orders: 460,
    unmapped: 0,
    lastImport: null,
    savedMapping: null,
  };
  const base: DatakallorData = {
    timeZone: "Europe/Stockholm",
    now: "2026-11-02T08:00:00Z",
    sources: [source],
    imports: [],
    queue: [],
    machines: [],
    lastMapped: null,
  };

  it("ingen källa", () => {
    expect(sp(headlineOf({ ...base, sources: [] }).title)).toBe("Ingen datakälla ännu.");
  });

  it("rubriken bygger på den senaste ordern, inte på senaste uppladdningen", () => {
    const h = headlineOf(base);
    expect(sp(h.title)).toBe("Data till 1 nov. 17:17.");
    expect(sp(h.aside)).toBe("460 order.");
    expect(h.tone).toBe("ok");
  });

  it("kön går före allt annat", () => {
    const h = headlineOf({
      ...base,
      queue: [
        {
          id: "q",
          dataSourceId: "s",
          dataSourceName: "Awish",
          externalId: "BL-009",
          externalName: "BL-009",
          pendingOrders: 12,
          firstOrderAt: null,
          lastOrderAt: null,
          suggestedMachineId: null,
        },
      ],
    });
    expect(sp(h.title)).toBe("1 automat att koppla.");
    expect(sp(h.aside)).toBe("12 order saknar automat.");
    expect(h.tone).toBe("warning");
  });

  it("inaktuell när den senaste ordern är mer än ett dygn gammal", () => {
    const h = headlineOf({ ...base, now: "2026-11-02T19:00:00Z" });
    expect(h.tone).toBe("warning");
    expect(sp(h.aside)).toBe("Mer än ett dygn gammal.");
  });

  it("en ny uppladdning utan nyare order gör inte datan färsk", () => {
    const h = headlineOf({
      ...base,
      now: "2026-11-23T10:00:00Z",
      sources: [{ ...source, lastSyncedAt: "2026-11-23T09:50:00Z" }],
    });
    expect(sp(h.title)).toBe("Data till 1 nov. 17:17.");
    expect(h.tone).toBe("warning");
  });
});

describe("förhandsvisningens texter", () => {
  it("ISO-datum skrivs som svenskt datum", () => {
    expect(sp(formatIsoDay("2026-11-01"))).toBe("1 nov. 2026");
    expect(sp(formatIsoDay("nej"))).toBe("–");
  });

  it("det som inte är nytt, med rätt böjning", () => {
    expect(notNewParts({ duplicate: 0, conflict: 1, error: 0, notPaid: 0 }).map(sp)).toEqual([
      "1 konflikt",
    ]);
    expect(notNewParts({ duplicate: 460, conflict: 2, error: 2, notPaid: 1 }).map(sp)).toEqual([
      "460 finns redan",
      "2 konflikter",
      "2 fel",
      "1 ej betald",
    ]);
  });

  it("varningarna får svensk tid och rätt böjning", () => {
    const warnings = localizeWarnings(
      [
        { code: "duplicate_file", message: "Samma fil har redan importerats (2026-11-02). …" },
        { code: "conflicts", message: "1 rader avviker …", rows: [3] },
        { code: "new_titles", message: '1 nya titlar: "X". Kontrollera dem.' },
        { code: "unknown_machines", message: '1 automater är inte kopplade: "Y". Orderna sparas.' },
      ],
      {
        previousImports: [
          { id: "i", fileName: "a.csv", finishedAt: "2026-11-02T09:50:00Z", rowsNew: 0 },
        ],
        summary: { conflict: 1, error: 0 } as never,
        newTitles: [{ name: "X" }] as never,
        unknownMachines: [{ externalId: "Y" }] as never,
      },
      "Europe/Stockholm",
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(warnings.map((w) => sp(w.message))).toEqual([
      "Samma fil importerades 2 nov. 10:50 (0 nya order). Order som redan finns räknas som dubbletter och ändras inte.",
      "1 rad avviker från order som redan finns. Orderna ändras inte; se importloggen.",
      '1 ny titel: "X". Kontrollera dem.',
      '1 automat är inte kopplad: "Y". Orderna sparas.',
    ]);
    expect(warnings[1]?.rows).toEqual([3]);
  });
});
