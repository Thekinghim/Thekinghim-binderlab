"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { formatInt } from "@/lib/format";

import {
  MAPPING_FIELD_LABELS,
  MAPPING_FIELDS,
  REQUIRED_MAPPING_FIELDS,
} from "../_lib/constants";
import type { FieldSource, ImportField, PreviewMapping } from "../_lib/types";

type Delimiter = "," | ";" | "\t";

/** Användarens mappning: fält → rubrik (null = finns inte i filen) och avgränsare. */
export interface MappingDraft {
  columns: Record<ImportField, string | null>;
  delimiter?: Delimiter;
}

const SOURCE_TEXT: Record<FieldSource, string | undefined> = {
  auto: "Hittad automatiskt",
  saved: "Sparad från förra filen",
  override: "Vald av dig",
  none: undefined,
};

const DELIMITERS: Array<{ value: Delimiter; label: string }> = [
  { value: ",", label: "Komma ( , )" },
  { value: ";", label: "Semikolon ( ; )" },
  { value: "\t", label: "Tabb" },
];

function asDelimiter(value: string): Delimiter {
  return value === ";" || value === "\t" ? value : ",";
}

/**
 * Kolumnmappningen: vilken kolumn i filen som är vilket fält. Förvalet är den
 * automatiska (eller sparade) mappningen. "Förhandsvisa igen" tolkar filen med
 * mappningen; vid import sparas den på datakällan till nästa fil.
 */
export function MappingEditor({
  mapping,
  missing = [],
  open = false,
  onApply,
  onCancel,
}: {
  mapping: PreviewMapping;
  missing?: readonly ImportField[];
  open?: boolean;
  onApply: (draft: MappingDraft) => void;
  onCancel?: () => void;
}) {
  const [columns, setColumns] = useState<Record<ImportField, string | null>>(() => ({
    ...mapping.columns,
  }));
  const [delimiter, setDelimiter] = useState<Delimiter>(asDelimiter(mapping.delimiter));
  const found = MAPPING_FIELDS.filter((f) => mapping.columns[f] !== null).length;
  const changed =
    MAPPING_FIELDS.some((f) => columns[f] !== mapping.columns[f]) ||
    delimiter !== asDelimiter(mapping.delimiter);
  const unmappedRequired = REQUIRED_MAPPING_FIELDS.filter((f) => columns[f] === null);
  const options = [
    { value: "", label: "Finns inte i filen" },
    ...mapping.headers.map((h) => ({ value: h, label: h })),
  ];

  return (
    <details open={open} className="group flex flex-col">
      <summary className="label flex cursor-pointer list-none items-center gap-2 text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <Icon name="chevronRight" size={12} className="transition-transform group-open:rotate-90" />
        Kolumnmappning · {formatInt(found)} av {formatInt(MAPPING_FIELDS.length)} fält
        {mapping.encoding ? ` · ${mapping.encoding.toUpperCase()}` : ""}
      </summary>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onApply({ columns, delimiter });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MAPPING_FIELDS.map((field) => {
            const required = REQUIRED_MAPPING_FIELDS.includes(field);
            const isMissing = missing.includes(field) && columns[field] === null;
            const fieldChanged = columns[field] !== mapping.columns[field];
            return (
              <Select
                key={field}
                label={`${MAPPING_FIELD_LABELS[field]}${required ? " *" : ""}`}
                value={columns[field] ?? ""}
                options={options}
                onChange={(e) =>
                  setColumns((c) => ({ ...c, [field]: e.target.value === "" ? null : e.target.value }))
                }
                error={isMissing ? "Obligatoriskt: välj kolumnen." : undefined}
                hint={fieldChanged ? "Ändrad" : SOURCE_TEXT[mapping.source[field]]}
              />
            );
          })}
          <Select
            label="Avgränsare"
            value={delimiter}
            options={DELIMITERS}
            onChange={(e) => setDelimiter(asDelimiter(e.target.value))}
            hint="Gissas från filen."
          />
        </div>
        <p className="text-sm text-muted">
          * Obligatoriskt. Mappningen sparas på datakällan när du importerar och används för nästa
          fil.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant={changed ? "primary" : "secondary"}
            disabled={unmappedRequired.length > 0}
          >
            Förhandsvisa med mappningen
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Avbryt
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
