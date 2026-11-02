"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";
import type { ReportType } from "@/server/reports/kinds";

import { createReport } from "../actions";
import { TextArea } from "./text-area";

const TYPES: { value: ReportType; label: string }[] = [
  { value: "butik", label: "Butik" },
  { value: "bokforing", label: "Bokföring" },
  { value: "delagare", label: "Delägare" },
];

/**
 * Val av rapport (typ, månad, butik) i URL:en, så att förhandsvisningen räknas på
 * servern och valet går att länka till (Att göra länkar hit). Hälsning och kommentar
 * följer med när utkastet skapas och sparas i rapportens underlag.
 */
export function ReportBuilder({
  type,
  month,
  months,
  stores,
  storeId,
  canEdit,
  canCreate,
  currentId,
}: {
  type: ReportType;
  month: string;
  months: { value: string; label: string }[];
  stores: readonly { id: string; name: string }[];
  storeId: string | null;
  canEdit: boolean;
  canCreate: boolean;
  currentId: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textId = useId();

  function go(next: { typ?: ReportType; manad?: string; butiken?: string | null }) {
    const q = new URLSearchParams(params.toString());
    q.delete("mottagare");
    q.delete("period");
    q.set("typ", next.typ ?? type);
    q.set("manad", next.manad ?? month);
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
        month,
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
        description: "Granska och godkänn det innan det skickas.",
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
        <Select
          label="Månad"
          options={months}
          value={month}
          onChange={(e) => go({ manad: e.target.value })}
        />
        {type === "butik" ? (
          stores.length > 0 ? (
            <Select
              label="Butik"
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
              value={storeId ?? ""}
              onChange={(e) => go({ butiken: e.target.value })}
            />
          ) : (
            <p className="text-sm text-muted">Ingen butik hade en automat under månaden.</p>
          )
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
        {textLabel && canEdit ? (
          <TextArea
            id={textId}
            label={textLabel}
            hint={
              type === "butik"
                ? "Står under rubriken i rapporten och som inledning i mejlet. Visas för butiken."
                : "Står under rubriken i delägarrapporten. Varje rad blir en punkt i mejlets plan."
            }
            value={text}
            maxLength={type === "butik" ? 1000 : 2000}
            rows={4}
            onChange={(e) => setText(e.target.value)}
          />
        ) : null}
        {type === "bokforing" ? (
          <p className="text-sm text-muted">
            Bokföringsunderlaget skapas som PDF, Excel och SIE 4 ur samma underlag.
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={create}
              loading={pending}
              disabled={!canCreate}
              iconLeft="plus"
            >
              {currentId ? "Skapa ny version" : "Skapa utkast"}
            </Button>
            {currentId ? (
              <a
                href={`/rapport/${currentId}`}
                className="rounded-xs text-sm text-muted underline-offset-4 transition-colors duration-fast ease-instrument hover:text-fg hover:underline"
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
          <p className="text-sm text-muted">Ägaren eller en admin skapar och skickar rapporterna.</p>
        )}
        {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}
      </div>
    </div>
  );
}
