"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { uploadPayoutFile } from "../actions";
import type { PayoutImportResultView } from "../_lib/types";
import { FormError } from "./bits";

/** Uppladdning av leverantörens utbetalningsfil (CSV) och resultatet av senaste uppladdningen. */
export function PayoutUpload({ columns }: { columns: { payouts: string; lines: string } }) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>();
  const [importedName, setImportedName] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<PayoutImportResultView>();
  const [pending, startTransition] = useTransition();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setError("Välj en CSV-fil med utbetalningar.");
      return;
    }
    setError(undefined);
    const form = new FormData();
    form.set("file", file);
    startTransition(async () => {
      const res = await uploadPayoutFile(form);
      if (!res.ok) {
        setError(res.error);
        setResult(undefined);
        return;
      }
      setResult(res.data);
      setImportedName(file.name);
      toast({
        title:
          res.data.format === "payouts"
            ? `${formatInt(res.data.rowsNew)} nya utbetalningar`
            : `${formatInt(res.data.rowsNew)} nya rader i specifikationen`,
        description: `${formatInt(res.data.rowsDuplicate)} fanns redan, ${formatInt(
          res.data.rowsConflict,
        )} konflikter, ${formatInt(res.data.rowsError)} felrader.`,
        tone: res.data.rowsConflict + res.data.rowsError > 0 ? "neutral" : "ok",
      });
      if (input.current) input.current.value = "";
      setFileName(undefined);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span id="payout-file-label" className="label text-muted">
            Utbetalningsfil (CSV)
          </span>
          {/* Webbläsarens filväljare visar text på webbläsarens språk; knappen är på svenska. */}
          <input
            ref={input}
            id="payout-file"
            name="file"
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              setFileName(e.target.files?.[0]?.name);
              setError(undefined);
            }}
          />
          <div className="flex min-w-0 items-center gap-3 rounded-sm border border-line-control bg-bg pr-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-labelledby="payout-file-label payout-file-button"
              aria-describedby="payout-file-name payout-file-hint"
              onClick={() => input.current?.click()}
            >
              <span id="payout-file-button">Välj fil</span>
            </Button>
            <span id="payout-file-name" className="min-w-0 truncate text-sm text-muted">
              {fileName ?? "Ingen fil vald"}
            </span>
          </div>
          <p id="payout-file-hint" className="text-xs text-subtle">
            Utbetalningar: {columns.payouts}. Specifikation per order: {columns.lines}.
          </p>
        </div>
        <Button type="submit" variant="primary" loading={pending}>
          Importera
        </Button>
      </form>
      <FormError message={error} />
      {result ? (
        <div role="status" className="flex flex-col gap-2 border-t border-line pt-3">
          <p className="meta text-muted">
            {importedName ?? "Filen"}: {formatInt(result.rowsTotal)} rader ·{" "}
            {formatInt(result.rowsNew)} nya · {formatInt(result.rowsDuplicate)} dubbletter ·{" "}
            {formatInt(result.rowsConflict)} konflikter · {formatInt(result.rowsError)} fel
          </p>
          {result.messages.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-muted">
              {result.messages.slice(0, 8).map((m) => (
                <li key={m}>{m}</li>
              ))}
              {result.messages.length > 8 ? (
                <li className="text-subtle">och {formatInt(result.messages.length - 8)} till.</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
