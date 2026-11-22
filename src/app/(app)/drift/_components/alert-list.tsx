"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import type { AlertSeverity } from "@/analytics/alerts";
import { sentence } from "@/analytics/todos/text";
import { Badge, type BadgeTone } from "@/components/v2/badge";
import { Button } from "@/components/v2/button";
import { toastV2 } from "@/components/v2/toast";
import { cn } from "@/lib/cn";

import { acknowledgeAlert } from "../actions";
import { seenText } from "../_lib/seen-text";

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
  /** Utskick om larmet som gått fram till någon. null = visas inte (inte ägare/admin). */
  readonly delivered: number | null;
  readonly occurrences: number;
  readonly acknowledged: string | null;
  readonly open: boolean;
}

const SEVERITY_TONE: Record<AlertSeverity, BadgeTone> = {
  critical: "critical",
  warning: "warning",
  info: "neutral",
};
const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Kritisk",
  warning: "Varning",
  info: "Info",
};

function AckButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      touch
      pending={pending}
      onClick={() =>
        start(async () => {
          const r = await acknowledgeAlert(id);
          if (r.ok) toastV2("Du tar det", { detail: "Inga fler påminnelser om det här." });
          else toastV2(r.error ?? "Det gick inte att spara. Försök igen.", { tone: "critical" });
        })
      }
      title="Inga fler påminnelser om det här larmet"
    >
      Jag tar det
    </Button>
  );
}

/** På telefon syns så här många larm innan "Visa alla". */
const MOBILE_COUNT = 3;

/**
 * Larm som rader i ett kort (V2): märke för allvaret, typ och tid, rubrik, text och underlaget
 * (regeln och talen) bakom en utfällning; "Jag tar det" till höger. Kritiska larm bär signal i
 * märket, inget annat.
 */
export function AlertList({ items, canAck }: { items: AlertItem[]; canAck: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 8);
  return (
    <div className="flex flex-col">
      <ul className="ops-list">
        {visible.map((a, i) => {
          const when = a.open ? `Sedan ${a.opened}` : `${a.opened} – ${a.closed ?? ""}`;
          return (
            <li
              key={a.id}
              // Telefon: bara de första larmen tills "Visa alla".
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1",
                !showAll && i >= MOBILE_COUNT && "max-[900px]:hidden",
              )}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-v2-xs text-v2-mute">
                  <Badge tone={a.open ? SEVERITY_TONE[a.severity] : "neutral"}>
                    {a.open ? SEVERITY_LABEL[a.severity] : "Löst"}
                  </Badge>
                  <span>{a.kindLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tnum">{when}</span>
                </div>
                <p className="text-v2-md font-[550] text-v2-ink">{sentence(a.title)}</p>
                <p className="text-v2-sm text-v2-mute max-[900px]:line-clamp-2">{a.detail}</p>
                <details className="ops-more">
                  <summary>Underlag</summary>
                  <div className="mt-1 mb-1 flex flex-col gap-2 text-v2-sm text-v2-mute">
                    {/* Telefon: texten ovan kortas efter två rader, här står den hel. */}
                    <p className="text-v2-ink min-[901px]:hidden">{a.detail}</p>
                    <p>{a.rule}</p>
                    {a.figures.length > 0 ? (
                      <dl className="ops-dl">
                        {a.figures.map((f) => (
                          <div key={f.label} className="contents">
                            <dt>{f.label}</dt>
                            <dd>{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    <p className="text-v2-xs text-v2-faint">{seenText(a)}</p>
                    <Link href={a.link} className="ops-link w-fit">
                      Öppna underlaget →
                    </Link>
                  </div>
                </details>
              </div>
              <div className="flex items-start pt-0.5">
                {a.acknowledged ? (
                  <span className="text-v2-xs text-v2-mute">{a.acknowledged}</span>
                ) : a.open && canAck ? (
                  <AckButton id={a.id} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > MOBILE_COUNT ? (
        <div
          className={cn(
            "border-t border-v2-line2 px-[18px] py-2",
            items.length <= 8 && "min-[901px]:hidden",
          )}
        >
          <Button variant="quiet" size="sm" touch onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Visa färre" : `Visa alla ${items.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
