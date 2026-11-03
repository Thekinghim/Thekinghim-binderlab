"use client";

/**
 * Rådgivarens förslag som kompakta kort: rubrik, varför, åtgärd, uppskattad effekt och
 * säkerhet, med Klar / Avfärda och "Fråga assistenten". Visas överst i Att göra och i
 * Assistent. Bara ägare och admin får förslagen (servern skickar inget annars).
 */

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { generateSuggestions, setSuggestionStatus } from "../actions";

export interface SuggestionCard {
  readonly id: string;
  readonly rank: number;
  readonly title: string;
  readonly why: string;
  readonly action: string;
  readonly effectSekMonth: number;
  readonly confidence: "high" | "medium" | "low";
}

const CONFIDENCE: Record<SuggestionCard["confidence"], string> = {
  high: "säker",
  medium: "trolig",
  low: "test",
};

const linkButton =
  "inline-flex h-7 items-center justify-center gap-2 rounded-sm border border-transparent px-2.5 text-sm font-medium whitespace-nowrap text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg";

/** Frågan som "Fråga assistenten" fyller i. */
export function askHref(s: SuggestionCard): string {
  const q = `Förslag: ${s.title}. ${s.why} ${s.action} Stämmer det, och hur gör jag konkret?`;
  return `/assistent?fraga=${encodeURIComponent(q.slice(0, 1900))}#fraga`;
}

export function Suggestions({
  items,
  manualLeft,
  canGenerate,
  emptyText,
}: {
  items: readonly SuggestionCard[];
  /** Kvar av dagens knapptryck, eller null när knappen inte ska visas. */
  manualLeft: number | null;
  canGenerate: boolean;
  emptyText?: string;
}) {
  const toast = useToast();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const visible = items.filter((s) => !hidden.has(s.id));

  const mark = (s: SuggestionCard, status: "done" | "dismissed") => {
    setHidden((h) => new Set(h).add(s.id));
    startTransition(async () => {
      const r = await setSuggestionStatus({ id: s.id, status });
      if (!r.ok) {
        setHidden((h) => {
          const n = new Set(h);
          n.delete(s.id);
          return n;
        });
        toast({ title: "Kunde inte spara", description: r.error, tone: "critical" });
        return;
      }
      toast({
        title: status === "done" ? "Klar" : "Avfärdad",
        description: s.title,
        action: {
          label: "Ångra",
          onClick: () =>
            startTransition(async () => {
              const u = await setSuggestionStatus({ id: s.id, status: "new" });
              if (u.ok) {
                setHidden((h) => {
                  const n = new Set(h);
                  n.delete(s.id);
                  return n;
                });
              }
            }),
        },
      });
    });
  };

  const generate = () =>
    startTransition(async () => {
      const r = await generateSuggestions();
      if (r.ok) {
        setHidden(new Set());
        toast({ title: `${formatInt(r.data?.accepted ?? 0)} nya förslag`, tone: "ok" });
      } else {
        toast({ title: "Inga nya förslag", description: r.error, tone: "critical" });
      }
    });

  return (
    <div className="flex flex-col gap-3">
      {visible.length === 0 ? (
        <p className="text-sm text-muted">{emptyText ?? "Inga öppna förslag."}</p>
      ) : (
        <ol className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map((s) => (
            <li
              key={s.id}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-4"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="min-w-0 text-base font-medium break-words text-fg">{s.title}</h3>
                <span className="meta tnum shrink-0 text-subtle">
                  {s.effectSekMonth > 0
                    ? `≈${NBSP}${formatInt(s.effectSekMonth)}${NBSP}kr/mån (uppskattning)`
                    : "effekt okänd"}
                  {` · ${CONFIDENCE[s.confidence]}`}
                </span>
              </div>
              <p className="text-sm break-words text-muted">{s.why}</p>
              <p className="text-sm break-words text-fg">
                <span className="text-subtle">Gör: </span>
                {s.action}
              </p>
              <div className="-ml-2.5 flex flex-wrap items-center gap-1 pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-2.5"
                  disabled={pending}
                  onClick={() => mark(s, "done")}
                  aria-label={`Klar: ${s.title}`}
                >
                  Klar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => mark(s, "dismissed")}
                  aria-label={`Avfärda: ${s.title}`}
                >
                  Avfärda
                </Button>
                <Link href={askHref(s)} className={cn(linkButton)}>
                  <span>Fråga assistenten</span>
                  <Icon name="chevronRight" className="-mr-0.5 shrink-0" />
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}
      {canGenerate && manualLeft !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            disabled={pending || manualLeft <= 0}
            onClick={generate}
          >
            Generera nya förslag
          </Button>
          <span className="meta text-subtle">
            {manualLeft > 0 ? `${formatInt(manualLeft)} kvar i dag` : "Inga fler i dag"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
