"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import type { AlertSeverity } from "@/analytics/alerts";
import { sentence } from "@/analytics/todos/text";
import { Button } from "@/components/ui/button";
import { StatusTag, type Status } from "@/components/ui/status-tag";
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
                  title: "Larmet kvitterat",
                  description: "Inga fler påminnelser om det här problemet.",
                }
              : { title: r.error ?? "Larmet kunde inte kvitteras", tone: "critical" },
          );
        })
      }
    >
      Kvittera
    </Button>
  );
}

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
        {visible.map((a) => (
          <li key={a.id} className="grid gap-3 py-4 md:grid-cols-12 md:gap-8">
            <div className="flex flex-col gap-2 md:col-span-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag status={a.open ? SEVERITY_TAG[a.severity].status : "neutral"}>
                  {a.open ? SEVERITY_TAG[a.severity].label : "Löst"}
                </StatusTag>
                <span className="label text-subtle">{a.kindLabel}</span>
              </div>
              <span className="meta text-subtle">
                {a.open ? `Sedan ${a.opened}` : `${a.opened} – ${a.closed ?? ""}`}
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1 md:col-span-6">
              <p className="text-base text-fg">{sentence(a.title)}</p>
              <p className="text-sm text-muted">{a.detail}</p>
              <details className="mt-1">
                <summary className="w-fit cursor-pointer rounded-xs text-sm text-muted hover:text-fg">
                  Underlag
                </summary>
                <div className="mt-2 flex flex-col gap-2 text-sm text-muted">
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
                  <p className="meta text-subtle">
                    {`Sett ${a.occurrences} ${a.occurrences === 1 ? "gång" : "gånger"}, aviserat ${a.notifyCount} ${a.notifyCount === 1 ? "gång" : "gånger"}, senast sett ${a.lastSeen}.`}
                  </p>
                  <Link
                    href={a.link}
                    className="w-fit rounded-xs text-fg underline-offset-2 hover:underline"
                  >
                    Öppna underlaget →
                  </Link>
                </div>
              </details>
            </div>
            <div className="flex items-start gap-2 md:col-span-3 md:justify-end">
              {a.acknowledged ? (
                <span className="meta text-subtle">{a.acknowledged}</span>
              ) : a.open && canAck ? (
                <AckButton id={a.id} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {items.length > 8 ? (
        <div className="pt-3">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Visa färre" : `Visa alla ${items.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
