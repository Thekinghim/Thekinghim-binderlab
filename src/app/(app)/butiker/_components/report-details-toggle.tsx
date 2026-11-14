"use client";

import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { setStoreReportDetails } from "../actions";

/**
 * "Visa detaljer i rapporten" för en butik (ägare och admin). Av (standard): butiken får
 * bara uträkningen. På: rapporten visar också titlar och service. Gäller rapporter som
 * skapas härefter; en godkänd eller skickad rapport ändras inte. Butiksportalens översikt
 * (som räknas varje gång den öppnas) följer valet direkt.
 */
export function ReportDetailsToggle({
  storeId,
  storeName,
  initial,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  initial: boolean;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  function save(next: boolean) {
    setOn(next);
    start(async () => {
      const res = await setStoreReportDetails({ storeId, details: next });
      if (!res.ok) {
        setOn(!next);
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      toast({
        title: next
          ? "Klart! Rapporten visar detaljer."
          : "Klart! Rapporten visar bara uträkningen.",
        description: "Gäller nästa rapport. Butiksportalen ändras direkt.",
        tone: "ok",
      });
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-line-strong px-4 py-3">
      <span className="flex min-w-0 flex-col">
        <span className="text-base text-fg">Visa detaljer i rapporten</span>
        <span className="meta text-subtle">
          Titlar och service. Av: butiken får bara uträkningen.
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Visa detaljer i rapporten, ${storeName}`}
        disabled={!canEdit || pending}
        onClick={() => save(!on)}
        className={cn(
          "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument disabled:opacity-60 max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-['']",
          on ? "border-up bg-up" : "border-line-control bg-raised",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "shadow inline-block size-6 rounded-full bg-fg transition-transform duration-fast ease-instrument",
            on ? "translate-x-7 bg-bg" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}
