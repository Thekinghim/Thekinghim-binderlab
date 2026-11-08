"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";
import type { IsoMonth } from "@/domain";
import type { ReportType } from "@/server/reports/kinds";
import { allowsRange, defaultRange, rangeError } from "@/server/reports/range";

import { createReport } from "../actions";
import { TextArea } from "./text-area";

const TYPES: { value: ReportType; label: string }[] = [
  { value: "butik", label: "Butik" },
  { value: "bokforing", label: "Bokföring" },
  { value: "delagare", label: "Delägare" },
];

/**
 * Val av rapport (typ, månad eller eget datum, butik) i URL:en, så att förhandsvisningen räknas på
 * servern och valet går att länka till (Att göra länkar hit). Hälsning och kommentar
 * följer med när utkastet skapas och sparas i rapportens underlag.
 */
export function ReportBuilder({
  type,
  month,
  range,
  rangeProblem,
  today,
  months,
  stores,
  storeId,
  canEdit,
  canCreate,
  currentId,
  overlap = null,
}: {
  type: ReportType;
  month: string;
  /** Eget datum som förhandsvisningen räknas på; null = hela månaden. */
  range: { start: string; end: string } | null;
  /** Fel i ett eget datum i adressen. */
  rangeProblem: string | null;
  /** Affärsdagen i dag, högsta till-datum. */
  today: string;
  months: { value: string; label: string }[];
  stores: readonly { id: string; name: string }[];
  storeId: string | null;
  canEdit: boolean;
  canCreate: boolean;
  currentId: string | null;
  /** Kort varning när underlaget överlappar ett annat (bokföring med eget datum). */
  overlap?: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const canRange = allowsRange(type);
  const [mode, setMode] = useState<"month" | "range">(
    canRange && (range || rangeProblem) ? "range" : "month",
  );
  // Det förhandsvisningen räknas på just nu: eget datum eller hela månaden.
  const shown = range ?? defaultRange(month as IsoMonth, today);
  const [from, setFrom] = useState(params.get("fran") ?? shown.start);
  const [to, setTo] = useState(params.get("till") ?? shown.end);
  const draftError = mode === "range" ? rangeError(from, to, today) : null;
  // Inmatat men inte visat än: utkastet skapas på det som visas, så Skapa väntar.
  const dirty = mode === "range" && (from !== shown.start || to !== shown.end);

  function go(next: {
    typ?: ReportType;
    manad?: string;
    butiken?: string | null;
    fran?: string | null;
    till?: string | null;
  }) {
    const q = new URLSearchParams(params.toString());
    q.delete("mottagare");
    q.delete("period");
    q.set("typ", next.typ ?? type);
    q.set("manad", next.manad ?? month);
    const typeNext = next.typ ?? type;
    const fran = next.fran === undefined ? q.get("fran") : next.fran;
    const till = next.till === undefined ? q.get("till") : next.till;
    if (fran && till && allowsRange(typeNext)) {
      q.set("fran", fran);
      q.set("till", till);
      q.set("manad", fran.slice(0, 7));
    } else {
      q.delete("fran");
      q.delete("till");
    }
    const store = next.butiken === undefined ? storeId : next.butiken;
    if ((next.typ ?? type) === "butik" && store) q.set("butiken", store);
    else q.delete("butiken");
    startNavigation(() => router.replace(`/rapporter?${q.toString()}`, { scroll: false }));
  }

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createReport({
        type,
        month: range ? range.start.slice(0, 7) : month,
        from: range?.start ?? null,
        to: range?.end ?? null,
        storeId: type === "butik" ? storeId : null,
        greeting: type === "butik" ? text : null,
        comment: type === "delagare" ? text : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setText("");
      toast({
        title: currentId ? "Ny version skapad" : "Utkast skapat",
        description: "Granska och godkänn.",
        tone: "ok",
      });
      router.refresh();
    });
  }

  const textLabel =
    type === "butik" ? "Personlig hälsning" : type === "delagare" ? "Egen kommentar" : null;

  return (
    <div
      className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-12"
      aria-busy={navigating || undefined}
    >
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
        <div className="flex flex-col gap-1.5">
          <span className="label text-muted" id={`${textId}-typ`}>
            Mottagare
          </span>
          <Segmented
            label="Rapporttyp"
            options={TYPES}
            value={type}
            onChange={(v) => go({ typ: v, butiken: v === "butik" ? storeId : null })}
          />
        </div>
        {mode === "month" || !canRange ? (
          <Select
            label="Månad"
            options={months}
            value={month}
            onChange={(e) => go({ manad: e.target.value, fran: null, till: null })}
          />
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draftError) go({ fran: from, till: to });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Från"
                type="date"
                value={from}
                max={today}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                label="Till"
                type="date"
                value={to}
                max={today}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            {draftError || rangeProblem ? (
              <p role="alert" className="text-sm text-signal-fg">
                {draftError ?? rangeProblem}
              </p>
            ) : null}
            <div>
              <Button type="submit" variant="secondary" disabled={Boolean(draftError) || !dirty}>
                Visa
              </Button>
            </div>
          </form>
        )}
        {canRange ? (
          <button
            type="button"
            role="switch"
            aria-checked={mode === "range"}
            onClick={() => {
              const next = mode === "range" ? "month" : "range";
              setMode(next);
              if (next === "month" && (range || rangeProblem)) go({ fran: null, till: null });
            }}
            className="label inline-flex h-8 w-fit items-center gap-2 rounded-sm text-muted transition-colors duration-fast ease-instrument hover:text-fg max-md:min-h-11"
          >
            <span
              aria-hidden
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-line-strong transition-colors duration-fast",
                mode === "range" ? "bg-fg" : "bg-transparent",
              )}
            >
              <span
                className={cn(
                  "absolute size-2.5 rounded-full transition-transform duration-fast ease-instrument",
                  mode === "range" ? "translate-x-3.5 bg-bg" : "translate-x-0.5 bg-muted",
                )}
              />
            </span>
            Eget datum
          </button>
        ) : null}
        {overlap ? (
          <p role="status" className="flex items-center gap-2 text-sm text-signal-fg">
            <span aria-hidden className="size-2 shrink-0 bg-signal" />
            {overlap}
          </p>
        ) : null}
        {type === "butik" ? (
          stores.length > 0 ? (
            <Select
              label="Butik"
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
              value={storeId ?? ""}
              onChange={(e) => go({ butiken: e.target.value })}
            />
          ) : (
            <p className="text-sm text-muted">
              Ingen butik hade en automat under {range ? "perioden" : "månaden"}.
            </p>
          )
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
        {textLabel && canEdit ? (
          <TextArea
            id={textId}
            label={textLabel}
            hint={type === "butik" ? "Visas för butiken." : "En rad = en punkt."}
            value={text}
            maxLength={type === "butik" ? 1000 : 2000}
            rows={4}
            onChange={(e) => setText(e.target.value)}
          />
        ) : null}
        {type === "bokforing" ? (
          <p className="text-sm text-muted">PDF, Excel och fil till Fortnox.</p>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={create}
              loading={pending}
              disabled={!canCreate || dirty}
              iconLeft="plus"
            >
              {currentId ? "Skapa ny version" : "Skapa utkast"}
            </Button>
            {currentId ? (
              <a
                href={`/rapport/${currentId}`}
                className="rounded-xs text-sm text-muted underline-offset-4 transition-colors duration-fast ease-instrument hover:text-fg hover:underline max-md:tap"
              >
                Öppna senaste versionen →
              </a>
            ) : null}
          </div>
        ) : currentId ? (
          <a
            href={`/rapport/${currentId}`}
            className="rounded-xs text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
          >
            Öppna rapporten →
          </a>
        ) : (
          <p className="text-sm text-muted">Ägaren skapar och skickar.</p>
        )}
        {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}
      </div>
    </div>
  );
}
