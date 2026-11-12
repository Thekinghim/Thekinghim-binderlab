"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { uploadPayoutFile } from "../actions";
import { devicesText, nayaxPaysText, nayaxSoldText, salesMatchText } from "../_lib/nayax";
import type { PayoutUploadResult } from "../_lib/types";
import { kr, periodText } from "../_lib/view";
import { FormError } from "./bits";
import { CardFeeFix } from "./card-fee-fix";

type NayaxResult = Extract<PayoutUploadResult, { kind: "nayax" }>;
type NayaxClash = Extract<PayoutUploadResult, { kind: "nayax_clash" }>;
type CsvResult = Extract<PayoutUploadResult, { kind: "csv" }>;

/**
 * Uppladdning av utbetalningar: Nayax månadsrapport (PDF, "Reimbursement Statement") eller en
 * CSV-fil. Efter en rapport visas vad som lästes: vad Nayax betalar, vad som drogs och om
 * försäljningen stämmer med appens.
 */
export function PayoutUpload({
  columns,
  today,
  shownPayoutIds,
}: {
  columns: { payouts: string; lines: string };
  today: string;
  /** Utbetalningarna som avstämningen visar just nu (där står kortavgiftens rad redan). */
  shownPayoutIds: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>();
  const [importedName, setImportedName] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CsvResult>();
  const [nayax, setNayax] = useState<NayaxResult>();
  const [clash, setClash] = useState<{ info: NayaxClash; file: File }>();
  const [pending, startTransition] = useTransition();

  const send = (file: File, replace?: string) => {
    setError(undefined);
    const form = new FormData();
    form.set("file", file);
    if (replace) form.set("replace", replace);
    startTransition(async () => {
      const res = await uploadPayoutFile(form).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      setResult(undefined);
      setNayax(undefined);
      setClash(undefined);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.data.kind === "nayax_clash") {
        setClash({ info: res.data, file });
        return;
      }
      if (res.data.kind === "nayax") {
        setNayax(res.data);
        toast({
          title:
            res.data.status === "duplicate"
              ? "Rapporten var redan inläst"
              : "Rapporten från Nayax är inläst",
          tone: "ok",
        });
      } else {
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
      }
      if (input.current) input.current.value = "";
      setFileName(undefined);
      router.refresh();
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setError("Välj rapporten från Nayax (PDF).");
      return;
    }
    send(file);
  };

  const match = nayax ? salesMatchText(nayax.statement.reimbursedOre, nayax.appSalesOre) : null;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span id="payout-file-label" className="label text-muted">
            Rapport från Nayax (PDF)
          </span>
          {/* Webbläsarens filväljare visar text på webbläsarens språk; knappen är på svenska. */}
          <input
            ref={input}
            id="payout-file"
            name="file"
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept=".pdf,application/pdf,.csv,text/csv,text/plain"
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
              className="max-md:min-h-11"
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
            Nayax mejlar rapporten varje månad. Den heter Reimbursement Statement.
          </p>
          <details className="text-xs text-subtle">
            <summary className="flex w-fit cursor-pointer items-center hover:text-muted max-md:min-h-11">
              Har du en CSV-fil?
            </summary>
            <p className="mt-1">
              Den går också att ladda upp här. Utbetalningar: {columns.payouts}. Per order:{" "}
              {columns.lines}.
            </p>
          </details>
        </div>
        <Button type="submit" variant="primary" loading={pending} className="max-md:min-h-11">
          Läs in
        </Button>
      </form>
      <FormError message={error} />
      {clash ? (
        <div
          role="alert"
          data-nayax-clash
          className="flex flex-col gap-3 border-t border-line pt-3"
        >
          <p className="text-sm text-fg">
            Du har redan skrivit in {kr(clash.info.manualAmountOre)} för hand för{" "}
            {periodText(clash.info.period)}. Rapporten från Nayax säger{" "}
            {kr(clash.info.totalOre)}. Inget är ändrat ännu.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              className="min-h-11 max-md:grow"
              loading={pending}
              onClick={() => send(clash.file, clash.info.manualId)}
            >
              Ersätt med rapporten
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 max-md:grow"
              disabled={pending}
              onClick={() => setClash(undefined)}
            >
              Avbryt
            </Button>
          </div>
        </div>
      ) : null}
      {nayax ? (
        <div
          role="status"
          data-nayax-result
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          {nayax.status === "duplicate" ? (
            <p className="meta text-subtle">Rapporten var redan inläst. Inget är ändrat.</p>
          ) : nayax.replaced ? (
            <p className="meta text-subtle">Den inskrivna utbetalningen är arkiverad.</p>
          ) : null}
          <p className="text-base font-medium text-fg">{nayaxPaysText(nayax.statement, today)}</p>
          <p className="text-sm text-muted">{nayaxSoldText(nayax.statement)}</p>
          <p className="text-sm text-fg">{match!.text}</p>
          {!match!.ok && nayax.statement.devices.length > 0 ? (
            <p className="text-sm text-muted">Hos Nayax: {devicesText(nayax.statement)}.</p>
          ) : null}
          {shownPayoutIds.includes(nayax.payoutId) ? null : (
            <CardFeeFix
              payoutId={nayax.payoutId}
              statementBp={nayax.statementCardFeeBp}
              settingBp={nayax.settingCardFeeBp}
            />
          )}
        </div>
      ) : null}
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
