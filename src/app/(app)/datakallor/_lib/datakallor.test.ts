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
import { formatBytes, formatWhen, formatWhenWithYear } from "./display";
import { headlineOf } from "./headline";
import { previewMapping, selectPreviewRows } from "./preview";
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
  };

  it("ingen källa", () => {
    expect(sp(headlineOf({ ...base, sources: [] }).title)).toBe("Ingen datakälla ännu.");
  });

  it("synkad och allt i ordning", () => {
    const h = headlineOf(base);
    expect(sp(h.title)).toBe("Synkad 1 nov. 21:23.");
    expect(sp(h.aside)).toBe("460 order importerade, alla automater kopplade.");
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
    expect(sp(h.aside)).toBe("1 automat väntar på koppling, 12 order saknar automat.");
    expect(h.tone).toBe("warning");
  });

  it("inaktuell efter mer än ett dygn", () => {
    const h = headlineOf({ ...base, now: "2026-11-03T08:00:00Z" });
    expect(h.tone).toBe("warning");
    expect(sp(h.aside)).toMatch(/Mer än ett dygn/);
  });
});
