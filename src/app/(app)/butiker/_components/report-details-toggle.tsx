"use client";

import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";

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
    <div className="bt-setting">
      <button
        type="button"
        role="switch"
        className="bt-switch"
        aria-checked={on}
        aria-label={`Visa detaljer i rapporten, ${storeName}`}
        disabled={!canEdit || pending}
        onClick={() => save(!on)}
      >
        <span className="min-w-0">
          <b>Visa detaljer i rapporten</b>
          <small>Titlar och service. Av: butiken får bara uträkningen.</small>
        </span>
        <span className="tg" aria-hidden="true" />
      </button>
    </div>
  );
}
