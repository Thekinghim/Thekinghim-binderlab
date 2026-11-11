"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { rememberKey, useRemembered } from "@/lib/remembered";

import { MAX_PACKS } from "../../../lager/_lib/schemas";
import { saveStockCount } from "../actions";
import {
  countedCount,
  newDraft,
  parseCount,
  parseDrafts,
  summarize,
  withCount,
  type CountDraft,
  type CountDrafts,
  type CountLine,
  type CountMode,
  type CountPlace,
  type CountRow,
} from "../_lib/model";

/** Ett nytt v4-id (randomUUID finns bara i säkra sammanhang; getRandomValues överallt). */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stora knappar och fält: tummen vid lagerhyllan. */
const BIG =
  "flex min-h-12 w-full items-center justify-center gap-2 rounded-md border px-4 text-lg font-medium disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled";
const PRIMARY = "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover";
const SECONDARY = "border-line-strong bg-surface text-fg active:bg-hover";

interface Done {
  readonly placeName: string;
  readonly lines: readonly CountLine[];
}

/**
 * Inventering, mobil först: välj lager, räkna (en produkt i taget eller som lista), se
 * skillnaderna och spara allt på en gång. Det man räknat sparas på telefonen per lager
 * (utkast), så en halvfärdig inventering finns kvar om appen stängs. Ett tomt fält =
 * produkten hoppas över och ändras inte. Samma tryck två gånger sparar en gång (utkastets
 * id följer med inskicket).
 */
export function CountFlow({
  places,
  rows,
  scope,
  initialPlaceId,
  stockHref,
}: {
  places: readonly CountPlace[];
  rows: readonly CountRow[];
  /** Organisation och användare: utkastet är personens eget. */
  scope: string;
  /** Lagret från länken (?lager=), t.ex. från Att göra. */
  initialPlaceId: string | null;
  stockHref: string;
}) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [stored, setStored] = useRemembered(rememberKey(scope, "inventering"));
  // Utan lagring (privat läge) lever utkastet i minnet så länge sidan är öppen.
  const [local, setLocal] = useState<CountDrafts | null>(null);
  const drafts = useMemo(() => local ?? parseDrafts(stored), [local, stored]);
  const [placeId, setPlaceId] = useState<string | null>(
    places.some((p) => p.id === initialPlaceId) ? initialPlaceId : null,
  );
  const [screen, setScreen] = useState<"count" | "review">("count");
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();

  const place = places.find((p) => p.id === placeId) ?? null;
  const draft = place ? drafts[place.id] : undefined;

  const write = (next: CountDrafts) => {
    setLocal(next);
    setStored(Object.keys(next).length === 0 ? null : JSON.stringify(next));
  };
  const update = (fn: (d: CountDraft) => CountDraft) => {
    if (!place) return;
    const current = drafts[place.id] ?? newDraft(newId(), new Date());
    write({ ...drafts, [place.id]: fn(current) });
  };
  const drop = (id: string) => {
    const next = { ...drafts };
    delete next[id];
    write(next);
  };

  if (done) {
    return (
      <DoneScreen
        done={done}
        stockHref={stockHref}
        more={places.length > 1}
        onAnother={() => {
          setDone(null);
          setPlaceId(null);
          setScreen("count");
        }}
      />
    );
  }

  if (!place) {
    return (
      <>
        <BackToStock href={stockHref} />
        <PlacePicker
          places={places}
          rows={rows}
          drafts={drafts}
          onPick={(id) => {
            setPlaceId(id);
            setScreen("count");
          }}
        />
      </>
    );
  }

  const summary = summarize(rows, place.id, draft?.counts ?? {}, draft?.seen ?? {});

  const save = () => {
    if (!draft || summary.lines.length === 0 || summary.invalid.length > 0 || pending) return;
    start(async () => {
      const res = await saveStockCount({
        clientId: draft.clientId,
        placeId: place.id,
        lines: summary.lines.map((l) => ({ titleId: l.titleId, counted: l.counted })),
      }).catch(() => ({ ok: false as const, error: t.common.offlineRetry }));
      if (!res.ok) {
        toast({
          title: t.count.notSaved,
          description: t.serverError(res.error ?? ""),
          tone: "critical",
        });
        return;
      }
      drop(place.id);
      setDone({ placeName: place.name, lines: res.data.lines });
      toast({ title: res.data.duplicate ? t.count.alreadySaved : t.count.saved, tone: "ok" });
      router.refresh();
    });
  };

  if (screen === "review") {
    return (
      <Review
        place={place}
        summary={summary}
        pending={pending}
        onSave={save}
        onEdit={() => setScreen("count")}
      />
    );
  }

  return (
    <Counting
      back={
        places.length > 1 ? (
          <BackButton onClick={() => setPlaceId(null)}>{t.count.changePlace}</BackButton>
        ) : (
          <BackToStock href={stockHref} />
        )
      }
      place={place}
      rows={rows}
      draft={draft}
      counted={summary.lines.length + summary.invalid.length}
      canReview={summary.lines.length > 0 && summary.invalid.length === 0}
      onChange={(titleId, text) =>
        update((d) =>
          withCount(d, titleId, text, new Date(), {
            // Vad appen tror just nu: ändras lagret innan man sparar pekas raden ut.
            expected: rows.find((r) => r.titleId === titleId)?.byPlace[place.id] ?? 0,
            // Ett ändrat antal är ett nytt inskick (ett redan sparat svar gäller inte det).
            clientId: newId(),
          }),
        )
      }
      onMode={(mode) => update((d) => ({ ...d, mode }))}
      onIndex={(index) => update((d) => ({ ...d, index }))}
      onReview={() => setScreen("review")}
      onDiscard={() => drop(place.id)}
    />
  );
}

const BACK =
  "-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md px-2 text-base text-muted active:bg-hover";

/** Tillbaka till lagret (Vårt lager, i Enkel vy Lager). */
export function BackToStock({ href }: { href: string }) {
  const t = useT();
  return (
    <Link href={href} className={BACK}>
      <Icon name="chevronLeft" size={16} />
      {t.count.toStock}
    </Link>
  );
}

function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={BACK}>
      <Icon name="chevronLeft" size={16} />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 1. Välj lager
// ---------------------------------------------------------------------------

function PlacePicker({
  places,
  rows,
  drafts,
  onPick,
}: {
  places: readonly CountPlace[];
  rows: readonly CountRow[];
  drafts: CountDrafts;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-balance text-fg md:text-3xl">
          {t.count.pickHeadline}
        </h1>
        <p className="text-base text-muted">{t.count.pickAside}</p>
      </header>
      <ul className="flex flex-col gap-3">
        {places.map((p) => {
          const started = countedCount(rows, drafts[p.id]);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                className="flex min-h-20 w-full items-center justify-between gap-3 rounded-md border border-line-strong bg-surface px-4 py-3 text-left active:bg-hover"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-xl font-medium [overflow-wrap:anywhere] text-fg">
                    {t.common.placeName(p.name)}
                  </span>
                  <span className="text-sm text-muted">
                    {p.lastCountedAt !== null && p.daysSince !== null
                      ? t.count.lastCounted(
                          fmt.date(new Date(p.lastCountedAt), { year: "auto" }),
                          p.daysSince,
                        )
                      : t.count.neverCounted}
                  </span>
                  {started > 0 ? (
                    <span className="text-sm font-medium text-fg">{t.count.resume(started)}</span>
                  ) : p.overdue ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg">
                      <Icon name="alert" size={14} />
                      {t.count.overdue}
                    </span>
                  ) : null}
                </span>
                <Icon name="chevronRight" size={20} className="shrink-0 text-muted" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. Räkna
// ---------------------------------------------------------------------------

function Counting({
  back,
  place,
  rows,
  draft,
  counted,
  canReview,
  onChange,
  onMode,
  onIndex,
  onReview,
  onDiscard,
}: {
  /** Vägen tillbaka: Byt lager, eller till lagret när det bara finns ett. */
  back: ReactNode;
  place: CountPlace;
  rows: readonly CountRow[];
  draft: CountDraft | undefined;
  counted: number;
  canReview: boolean;
  onChange: (titleId: string, text: string) => void;
  onMode: (mode: CountMode) => void;
  onIndex: (index: number) => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const ids = useId();
  const mode: CountMode = draft?.mode ?? "step";
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const counts = draft?.counts ?? {};

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        {/* Tillbaka och vyn på samma rad, så att fältet och Nästa får plats utan att scrolla. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {back}
          <div
            role="radiogroup"
            aria-label={t.count.modeLabel}
            className="flex gap-1 rounded-md border border-line-strong bg-surface p-1"
          >
            {(["step", "list"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => onMode(m)}
                className={cn(
                  "flex min-h-11 min-w-11 items-center justify-center rounded-sm px-3 text-base font-medium",
                  mode === m ? "bg-inverse text-on-inverse" : "text-muted active:bg-hover",
                )}
              >
                {m === "step" ? t.count.modeStep : t.count.modeList}
              </button>
            ))}
          </div>
        </div>
        <h1 className="text-2xl font-medium text-balance text-fg md:text-3xl">
          {t.count.countHeadline(place.name)}
        </h1>
        <p className="tnum text-base text-muted" aria-live="polite">
          {t.count.progress(counted, rows.length)}
          {counted > 0 ? ` · ${t.count.draftKept}` : ""}
        </p>
      </header>

      {mode === "step" ? (
        <Step
          key={place.id}
          place={place}
          rows={rows}
          counts={counts}
          index={Math.min(draft?.index ?? 0, rows.length - 1)}
          counted={counted}
          canReview={canReview}
          onChange={onChange}
          onIndex={onIndex}
          onReview={onReview}
        />
      ) : (
        <ul
          aria-label={t.count.title}
          className="flex flex-col divide-y divide-line rounded-md border border-line"
        >
          {rows.map((r) => {
            const text = counts[r.titleId] ?? "";
            const bad = text !== "" && !parseCount(text).ok;
            const fieldId = `${ids}-${r.titleId}`;
            return (
              <li key={r.titleId} className="flex items-center justify-between gap-3 px-3 py-2">
                <label htmlFor={fieldId} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-base font-medium [overflow-wrap:anywhere] text-fg">
                    {r.name}
                  </span>
                  <span className={cn("tnum text-sm", bad ? "text-signal-fg" : "text-muted")}>
                    {bad ? t.count.invalid(MAX_PACKS) : t.count.appThinks(r.byPlace[place.id] ?? 0)}
                  </span>
                </label>
                <input
                  id={fieldId}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  placeholder="–"
                  value={text}
                  onChange={(e) => onChange(r.titleId, e.target.value)}
                  aria-invalid={bad ? true : undefined}
                  className="tnum h-12 w-24 shrink-0 rounded-md border border-line-control bg-bg px-3 text-right text-xl text-fg"
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {mode === "list" ? (
          <button
            type="button"
            onClick={onReview}
            disabled={!canReview}
            className={cn(BIG, PRIMARY)}
          >
            {counted > 0 ? t.count.review(counted) : t.count.reviewNone}
          </button>
        ) : null}
        {draft && counted > 0 ? (
          confirmDiscard ? (
            <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-3">
              <p className="text-base text-fg">{t.count.discardConfirm}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDiscard(false);
                    onDiscard();
                  }}
                  className={cn(BIG, SECONDARY, "min-h-11 text-base")}
                >
                  {t.count.discardYes}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className={cn(BIG, SECONDARY, "min-h-11 text-base")}
                >
                  {t.count.discardNo}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="inline-flex min-h-11 items-center justify-center self-center rounded-md px-3 text-base text-muted underline underline-offset-4 active:bg-hover"
            >
              {t.count.discard}
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}

/** En produkt i taget: stort namn, "Appen tror", ett stort fält, Förra och Nästa. */
function Step({
  place,
  rows,
  counts,
  index,
  counted,
  canReview,
  onChange,
  onIndex,
  onReview,
}: {
  place: CountPlace;
  rows: readonly CountRow[];
  counts: Readonly<Record<string, string>>;
  index: number;
  counted: number;
  canReview: boolean;
  onChange: (titleId: string, text: string) => void;
  onIndex: (index: number) => void;
  onReview: () => void;
}) {
  const t = useT();
  const ids = useId();
  const row = rows[Math.max(0, index)];
  if (!row) return null;
  const expected = row.byPlace[place.id] ?? 0;
  const text = counts[row.titleId] ?? "";
  const bad = text !== "" && !parseCount(text).ok;
  const last = index >= rows.length - 1;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        if (!last) onIndex(index + 1);
        else if (canReview) onReview();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2 rounded-md border border-line px-4 py-4">
        <p className="label tnum text-subtle">{t.count.stepOf(index + 1, rows.length)}</p>
        <h2 className="text-2xl font-medium [overflow-wrap:anywhere] text-fg">{row.name}</h2>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="tnum text-lg text-muted">{t.count.appThinks(expected)}</p>
          {expected >= 0 && text !== String(expected) ? (
            <button
              type="button"
              onClick={() => onChange(row.titleId, String(expected))}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg active:bg-hover"
            >
              <Icon name="check" size={16} />
              {t.count.matches}
            </button>
          ) : null}
        </div>
        <label htmlFor={`${ids}-n`} className="label text-subtle">
          {t.count.fieldLabel}
        </label>
        <input
          key={row.titleId}
          id={`${ids}-n`}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="–"
          value={text}
          onChange={(e) => onChange(row.titleId, e.target.value)}
          aria-label={t.count.fieldAria(row.name)}
          aria-invalid={bad ? true : undefined}
          aria-describedby={bad ? `${ids}-msg` : undefined}
          className="tnum h-14 w-full min-w-0 rounded-md border border-line-control bg-bg px-3 text-center text-3xl text-fg"
        />
        {bad ? (
          <p id={`${ids}-msg`} role="alert" className="text-sm text-signal-fg">
            {t.count.invalid(MAX_PACKS)}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onIndex(index - 1)}
          disabled={index <= 0}
          className={cn(BIG, SECONDARY)}
        >
          <Icon name="chevronLeft" size={18} />
          {t.count.prev}
        </button>
        {last ? (
          <span />
        ) : (
          <button
            type="submit"
            disabled={bad}
            className={cn(BIG, text === "" ? SECONDARY : PRIMARY)}
          >
            {text === "" ? t.count.skip : t.count.next}
            <Icon name="chevronRight" size={18} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onReview}
        disabled={!canReview}
        className={cn(BIG, last ? PRIMARY : SECONDARY)}
      >
        {counted > 0 ? t.count.review(counted) : t.count.reviewNone}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3. Skillnader och Spara
// ---------------------------------------------------------------------------

function DiffList({ lines }: { lines: readonly CountLine[] }) {
  const t = useT();
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
      {lines.map((l) => (
        <li
          key={l.titleId}
          aria-label={t.count.diffAria(l.name, l.previous, l.counted)}
          className="flex items-baseline justify-between gap-3 px-4 py-3"
        >
          <span className="min-w-0 text-base font-medium [overflow-wrap:anywhere] text-fg">
            {l.name}
          </span>
          <span className="tnum shrink-0 text-lg font-medium text-fg">
            {t.count.diff(l.previous, l.counted)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Review({
  place,
  summary,
  pending,
  onSave,
  onEdit,
}: {
  place: CountPlace;
  summary: ReturnType<typeof summarize>;
  pending: boolean;
  onSave: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <p className="label text-subtle">
          {t.count.summaryTitle} · {t.common.placeName(place.name)}
        </p>
        <h1 className="text-2xl font-medium text-balance text-fg md:text-3xl">
          {t.count.summaryHeadline(summary.changed.length)}
        </h1>
      </header>
      {summary.stale.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-line-strong px-4 py-3"
        >
          <p className="flex items-center gap-2 text-base font-medium text-fg">
            <Icon name="alert" size={16} className="shrink-0" />
            {t.count.staleTitle}
          </p>
          <ul className="flex flex-col gap-1">
            {summary.stale.map((l) => (
              <li key={l.titleId} className="tnum text-base [overflow-wrap:anywhere] text-fg">
                {t.count.staleLine(l.name, l.seen, l.previous)}
              </li>
            ))}
          </ul>
          <p className="text-base text-muted">{t.count.staleHint}</p>
        </div>
      ) : null}
      {summary.changed.length > 0 ? <DiffList lines={summary.changed} /> : null}
      <p className="tnum text-base text-muted">
        {[
          ...(summary.same > 0 ? [t.count.same(summary.same)] : []),
          ...(summary.skipped > 0 ? [t.count.skipped(summary.skipped)] : []),
        ].join(" · ")}
      </p>
      <div className="flex flex-col gap-2">
        <button type="button" onClick={onSave} disabled={pending} className={cn(BIG, PRIMARY)}>
          <Icon name="check" size={18} />
          {pending ? t.common.saving : t.count.save}
        </button>
        <button type="button" onClick={onEdit} disabled={pending} className={cn(BIG, SECONDARY)}>
          {t.count.edit}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4. Sparat
// ---------------------------------------------------------------------------

function DoneScreen({
  done,
  stockHref,
  more,
  onAnother,
}: {
  done: Done;
  stockHref: string;
  more: boolean;
  onAnother: () => void;
}) {
  const t = useT();
  const changed = done.lines.filter((l) => l.previous !== l.counted);
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-balance text-fg md:text-3xl">{t.count.saved}</h1>
        <p className="text-base text-muted">
          {t.count.savedAside(done.placeName, done.lines.length)}
        </p>
      </header>
      {changed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="label text-subtle">{t.count.savedChanges}</h2>
          <DiffList lines={changed} />
        </div>
      ) : (
        <p className="text-base text-fg">{t.count.savedNoChanges}</p>
      )}
      <div className="flex flex-col gap-2">
        <Link href={stockHref} className={cn(BIG, PRIMARY)}>
          {t.count.toStock}
        </Link>
        {more ? (
          <button type="button" onClick={onAnother} className={cn(BIG, SECONDARY)}>
            {t.count.countAnother}
          </button>
        ) : null}
      </div>
    </section>
  );
}
