"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import type { AlertSeverity } from "@/analytics/alerts";
import { sentence } from "@/analytics/todos/text";
import { Button } from "@/components/ui/button";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";

import { acknowledgeAlert } from "../actions";

/** Ett larm som det visas (serialiserbart). */
export interface AlertItem {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly kindLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly rule: string;
  readonly figures: { label: string; value: string }[];
  readonly link: string;
  readonly opened: string;
  readonly lastSeen: string;
  readonly closed: string | null;
  readonly notifyCount: number;
  readonly occurrences: number;
  readonly acknowledged: string | null;
  readonly open: boolean;
}

const SEVERITY_TAG: Record<AlertSeverity, { status: Status; label: string }> = {
  critical: { status: "critical", label: "Kritisk" },
  warning: { status: "warning", label: "Varning" },
  info: { status: "neutral", label: "Info" },
};

function AckButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <Button
      size="sm"
      loading={pending}
      onClick={() =>
        start(async () => {
          const r = await acknowledgeAlert(id);
          toast(
            r.ok
              ? {
                  title: "Du tar det",
                  description: "Inga fler påminnelser om det här.",
                }
              : { title: r.error ?? "Det gick inte att spara. Försök igen.", tone: "critical" },
          );
        })
      }
      title="Inga fler påminnelser om det här larmet"
    >
      Jag tar det
    </Button>
  );
}

/** På mobil syns så här många larm innan "Visa alla". */
const MOBILE_COUNT = 3;

/**
 * Larm som lista: allvar, rubrik, text och underlaget (regeln och talen) bakom en
 * utfällning. Kritiska larm bär signal i statusetiketten, inget annat.
 */
export function AlertList({ items, canAck }: { items: AlertItem[]; canAck: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 8);
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {visible.map((a, i) => (
          <li
            key={a.id}
            // Mobil: rubrik och en rad till vänster, Kvittera till höger; bara de första
            // larmen tills "Visa alla" (från md som förut).
            className={cn(
              "grid gap-3 py-4 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:py-3 md:grid-cols-12 md:gap-8",
              !showAll && i >= MOBILE_COUNT && "max-md:hidden",
            )}
          >
            <div className="flex flex-col gap-2 max-md:col-start-1 md:col-span-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag status={a.open ? SEVERITY_TAG[a.severity].status : "neutral"}>
                  {a.open ? SEVERITY_TAG[a.severity].label : "Löst"}
                </StatusTag>
                <span className="label text-subtle max-md:hidden">{a.kindLabel}</span>
              </div>
              <span className="meta text-subtle max-md:hidden">
                {a.open ? `Sedan ${a.opened}` : `${a.opened} – ${a.closed ?? ""}`}
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1 max-md:col-start-1 md:col-span-6">
              <p className="text-base text-fg">{sentence(a.title)}</p>
              <p className="text-sm text-muted max-md:line-clamp-2">{a.detail}</p>
              <details className="mt-1">
                <summary className="w-fit cursor-pointer rounded-xs text-sm text-muted hover:text-fg max-md:tap max-md:flex max-md:min-h-11 max-md:items-center">
                  Underlag
                </summary>
                <div className="mt-2 flex flex-col gap-2 text-sm text-muted">
                  {/* Mobil: texten ovan kortas efter två rader, här står den hel. */}
                  <p className="text-fg md:hidden">{a.detail}</p>
                  <p className="meta text-subtle md:hidden">
                    {`${a.kindLabel} · ${a.open ? `Sedan ${a.opened}` : `${a.opened} – ${a.closed ?? ""}`}`}
                  </p>
                  <p>{a.rule}</p>
                  {a.figures.length > 0 ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      {a.figures.map((f) => (
                        <div key={f.label} className="contents">
                          <dt className="label text-subtle">{f.label}</dt>
                          <dd className="tnum text-fg">{f.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  <p className="text-sm text-subtle">
                    {`Sett ${a.occurrences} ${a.occurrences === 1 ? "gång" : "gånger"}, aviserat ${a.notifyCount} ${a.notifyCount === 1 ? "gång" : "gånger"}, senast sett ${a.lastSeen}.`}
                  </p>
                  <Link
                    href={a.link}
                    className="w-fit rounded-xs text-fg underline-offset-2 hover:underline max-md:flex max-md:min-h-11 max-md:items-center"
                  >
                    Öppna underlaget →
                  </Link>
                </div>
              </details>
            </div>
            <div className="flex items-start gap-2 max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 md:col-span-3 md:justify-end max-md:[&_button]:h-11">
              {a.acknowledged ? (
                <span className="meta text-subtle">{a.acknowledged}</span>
              ) : a.open && canAck ? (
                <AckButton id={a.id} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {items.length > MOBILE_COUNT ? (
        <div className={cn("pt-3", items.length <= 8 && "md:hidden")}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            className="max-md:h-11"
          >
            {showAll ? "Visa färre" : `Visa alla ${items.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
