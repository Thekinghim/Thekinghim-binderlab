"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { PackImage } from "@/components/v2/pack-image";
import { PeriodSegment } from "@/components/v2/period-segment";
import { SearchField } from "@/components/v2/search-field";
import { PageFilters } from "@/components/v2/shell/page-filters";
import { Sheet, SheetClose } from "@/components/v2/sheet";
import { cn } from "@/lib/cn";

import { chipName } from "../_lib/day-groups";
import { cleanQuery, withOrderParams, type OrderParamsPatch } from "../_lib/params";
import type { TitleOption } from "../_lib/types";

const SEARCH_DELAY_MS = 300;

/** Navigering med nya filter (utan öppen order), i en övergång så att listan kan tona. */
export function useOrderNavigate(): {
  navigate: (patch: OrderParamsPatch) => void;
  pending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback(
    (patch: OrderParamsPatch) => {
      const next = withOrderParams(searchParams, { ...patch, orderId: null });
      const q = next.toString();
      startTransition(() => {
        router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      });
    },
    [router, pathname, searchParams],
  );
  return { navigate, pending };
}

/** Sökfältet: skickas när man slutat skriva en stund (eller trycker Enter). */
export function OrderSearch({
  q,
  onChange,
  className,
}: {
  q: string;
  onChange: (patch: OrderParamsPatch) => void;
  className?: string;
}) {
  const [text, setText] = useState(q);
  const sent = useRef(q);

  useEffect(() => {
    const clean = cleanQuery(text);
    if (clean === sent.current) return;
    const t = setTimeout(() => {
      sent.current = clean;
      onChange({ q: clean });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text, onChange]);

  // Ändrades sökningen utifrån (Rensa, bakåt i historiken) följer fältet med.
  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q;
      setText(q);
    }
  }, [q]);

  return (
    <form
      role="search"
      aria-label="Sök order"
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const clean = cleanQuery(text);
        sent.current = clean;
        onChange({ q: clean });
      }}
    >
      <SearchField
        value={text}
        onChange={setText}
        placeholder="Sök titel, automat eller ordernummer"
        ariaLabel="Sök order på titel, automat, butik eller ordernummer"
      />
    </form>
  );
}

/**
 * Titelchipsen: Alla titlar, de mest sålda titlarna med packbild och (om fler finns) en
 * lista med resten. Ett val åt gången; en vald titel utanför topplistan får ett eget chip.
 */
export function TitleChips({
  titleId,
  topTitleIds,
  titleOptions,
  onChange,
  wrap = false,
}: {
  titleId: string | null;
  topTitleIds: readonly string[];
  titleOptions: readonly TitleOption[];
  onChange: (patch: OrderParamsPatch) => void;
  wrap?: boolean;
}) {
  const byId = useMemo(() => new Map(titleOptions.map((t) => [t.id, t])), [titleOptions]);
  const chips = useMemo(() => {
    const ids = topTitleIds.filter((id) => byId.has(id));
    if (titleId && byId.has(titleId) && !ids.includes(titleId)) ids.push(titleId);
    return ids.map((id) => byId.get(id)!);
  }, [topTitleIds, titleId, byId]);
  const rest = titleOptions.filter((t) => !chips.some((c) => c.id === t.id));

  return (
    // "Fler titlar" står utanför den rullande raden, så att den alltid syns.
    <div className={cn("ord-chips-w", wrap && "wrap")} role="group" aria-label="Titel">
      <div className={cn("ord-chips", wrap && "wrap")}>
        <button
          type="button"
          className="ord-chip all"
          aria-pressed={titleId === null}
          onClick={() => onChange({ titleId: null })}
        >
          Alla titlar
        </button>
        {chips.map((t) => (
          <button
            key={t.id}
            type="button"
            className="ord-chip"
            aria-pressed={titleId === t.id}
            title={t.name}
            onClick={() => onChange({ titleId: titleId === t.id ? null : t.id })}
          >
            <PackImage title={t.name} size="xs" />
            <span className="nm">{chipName(t.name)}</span>
          </button>
        ))}
      </div>
      {rest.length > 0 ? (
        <label className="ord-more">
          <span className="sr-only">Fler titlar</span>
          <select
            value=""
            onChange={(e) => e.target.value && onChange({ titleId: e.target.value })}
          >
            <option value="">Fler titlar</option>
            {rest.map((t) => (
              <option key={t.id} value={t.id}>
                {t.archived ? `${t.name} (arkiverad)` : t.name}
              </option>
            ))}
          </select>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m7 10 5 5 5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </label>
      ) : null}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  );
}

/**
 * Telefonens rad överst: periodvalet och en knapp som öppnar alla filter i ett ark (sök,
 * titel, butik, automat, VMB). Siffran på knappen = antal aktiva filter. Skalets egen
 * periodrad och filterrad döljs på Order på telefon (order.css), så valen finns på ett ställe.
 */
export function OrderPhoneBar({
  q,
  titleId,
  topTitleIds,
  titleOptions,
}: {
  q: string;
  titleId: string | null;
  topTitleIds: readonly string[];
  titleOptions: readonly TitleOption[];
}) {
  const { navigate } = useOrderNavigate();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  const active =
    (q ? 1 : 0) +
    (titleId ? 1 : 0) +
    (sp.get("butik") || sp.get("agare") ? 1 : 0) +
    (sp.get("automat") ? 1 : 0) +
    (sp.get("vmb") === "1" ? 1 : 0);

  return (
    <div className="ord-pbar">
      <PeriodSegment className="ord-pseg" />
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Filtrera order"
        trigger={
          <button
            type="button"
            className={cn("v2-btn ico ord-fbtn", active > 0 && "on")}
            aria-label={active > 0 ? `Filter, ${active} aktiva` : "Filter"}
          >
            <FilterIcon />
            {active > 0 ? (
              <span className="n" aria-hidden="true">
                {active}
              </span>
            ) : null}
          </button>
        }
        footer={
          <>
            {active > 0 ? (
              <Button
                variant="plain"
                onClick={() => {
                  navigate({ q: "", titleId: null });
                }}
              >
                Rensa sökning och titel
              </Button>
            ) : null}
            <SheetClose asChild>
              <Button variant="act">Klar</Button>
            </SheetClose>
          </>
        }
      >
        <div className="ord-fsheet">
          <OrderSearch q={q} onChange={navigate} />
          <div>
            <h3 className="ord-fh">Titel</h3>
            <TitleChips
              titleId={titleId}
              topTitleIds={topTitleIds}
              titleOptions={titleOptions}
              onChange={navigate}
              wrap
            />
          </div>
          <div className="ord-fscope">
            <h3 className="ord-fh">Butik och automat</h3>
            <PageFilters />
          </div>
        </div>
      </Sheet>
    </div>
  );
}
