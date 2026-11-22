"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/v2/notice";
import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { rememberKey, useRemembered } from "@/lib/remembered";

import "./count.css";

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

/** Knappar: V2 (.v2-btn), 44 px höga, i full bredd i knappraderna (count.css). */
const PRIMARY = "v2-btn act lg";
const SECONDARY = "v2-btn lg";

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

const BACK = "v2-btn quiet lg back";

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
    <section className="v2-count">
      <header className="hd">
        <h2>{t.count.pickHeadline}</h2>
        <p>{t.count.pickAside}</p>
      </header>
      <ul className="v2-card rows">
        {places.map((p) => {
          const started = countedCount(rows, drafts[p.id]);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p.id)} className="pick">
                <span className="min-w-0">
                  <b>{t.common.placeName(p.name)}</b>
                  <small>
                    {p.lastCountedAt !== null && p.daysSince !== null
                      ? t.count.lastCounted(
                          fmt.date(new Date(p.lastCountedAt), { year: "auto" }),
                          p.daysSince,
                        )
                      : t.count.neverCounted}
                  </small>
                  {started > 0 ? (
                    <span className="flag v2-badge info">{t.count.resume(started)}</span>
                  ) : p.overdue ? (
                    <span className="flag v2-badge warning">{t.count.overdue}</span>
                  ) : null}
                </span>
                <Icon name="chevronRight" size={18} className="chev" />
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
    <section className="v2-count">
      {/* Tillbaka och vyn på samma rad, så att fältet och Nästa får plats utan att scrolla. */}
      <div className="bar">
        {back}
        <div role="radiogroup" aria-label={t.count.modeLabel} className="seg">
          {(["step", "list"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => onMode(m)}
            >
              {m === "step" ? t.count.modeStep : t.count.modeList}
            </button>
          ))}
        </div>
      </div>
      <header className="hd">
        <h2>{t.count.countHeadline(place.name)}</h2>
        <p aria-live="polite">
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
        <ul aria-label={t.count.title} className="v2-card rows">
          {rows.map((r) => {
            const text = counts[r.titleId] ?? "";
            const bad = text !== "" && !parseCount(text).ok;
            const fieldId = `${ids}-${r.titleId}`;
            return (
              <li key={r.titleId} className="line">
                <label htmlFor={fieldId} className="nm">
                  <b>{r.name}</b>
                  <small className={bad ? "bad" : undefined}>
                    {bad ? t.count.invalid(MAX_PACKS) : t.count.appThinks(r.byPlace[place.id] ?? 0)}
                  </small>
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
                  className="v2-input num"
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="acts">
        {mode === "list" ? (
          <button type="button" onClick={onReview} disabled={!canReview} className={PRIMARY}>
            {counted > 0 ? t.count.review(counted) : t.count.reviewNone}
          </button>
        ) : null}
        {draft && counted > 0 ? (
          confirmDiscard ? (
            <div className="v2-card v2-card-body flex flex-col gap-3">
              <p className="text-v2-md text-v2-ink">{t.count.discardConfirm}</p>
              <div className="two">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDiscard(false);
                    onDiscard();
                  }}
                  className={SECONDARY}
                >
                  {t.count.discardYes}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className={SECONDARY}
                >
                  {t.count.discardNo}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="v2-btn quiet lg self-center"
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
      className="flex flex-col gap-3"
    >
      <div className="v2-card v2-card-body one">
        <p className="v2-lab tnum">{t.count.stepOf(index + 1, rows.length)}</p>
        <h2>{row.name}</h2>
        <div className="thinks">
          <p>{t.count.appThinks(expected)}</p>
          {expected >= 0 && text !== String(expected) ? (
            <button
              type="button"
              onClick={() => onChange(row.titleId, String(expected))}
              className="v2-btn lg"
            >
              <Icon name="check" size={16} />
              {t.count.matches}
            </button>
          ) : null}
        </div>
        <label htmlFor={`${ids}-n`}>{t.count.fieldLabel}</label>
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
          className="v2-input big"
        />
        {bad ? (
          <p id={`${ids}-msg`} role="alert" className="err">
            {t.count.invalid(MAX_PACKS)}
          </p>
        ) : null}
      </div>
      <div className="two">
        <button
          type="button"
          onClick={() => onIndex(index - 1)}
          disabled={index <= 0}
          className={SECONDARY}
        >
          <Icon name="chevronLeft" size={18} />
          {t.count.prev}
        </button>
        {last ? (
          <span />
        ) : (
          <button type="submit" disabled={bad} className={text === "" ? SECONDARY : PRIMARY}>
            {text === "" ? t.count.skip : t.count.next}
            <Icon name="chevronRight" size={18} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onReview}
        disabled={!canReview}
        className={cn(last ? PRIMARY : SECONDARY, "w-full")}
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
    <ul className="v2-card rows">
      {lines.map((l) => (
        <li
          key={l.titleId}
          aria-label={t.count.diffAria(l.name, l.previous, l.counted)}
          className="line"
        >
          <span className="nm">
            <b>{l.name}</b>
          </span>
          <span className="df">{t.count.diff(l.previous, l.counted)}</span>
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
    <section className="v2-count">
      <header className="hd">
        <h2>{t.count.summaryHeadline(summary.changed.length)}</h2>
        <p>
          {t.count.summaryTitle} · {t.common.placeName(place.name)}
        </p>
      </header>
      {summary.stale.length > 0 ? (
        <div role="alert" className="stale">
          <Notice tone="warning" title={t.count.staleTitle}>
            <ul>
              {summary.stale.map((l) => (
                <li key={l.titleId}>{t.count.staleLine(l.name, l.seen, l.previous)}</li>
              ))}
            </ul>
            <p>{t.count.staleHint}</p>
          </Notice>
        </div>
      ) : null}
      {summary.changed.length > 0 ? <DiffList lines={summary.changed} /> : null}
      <p className="note">
        {[
          ...(summary.same > 0 ? [t.count.same(summary.same)] : []),
          ...(summary.skipped > 0 ? [t.count.skipped(summary.skipped)] : []),
        ].join(" · ")}
      </p>
      <div className="acts">
        <button type="button" onClick={onSave} disabled={pending} className={PRIMARY}>
          <Icon name="check" size={16} />
          {pending ? t.common.saving : t.count.save}
        </button>
        <button type="button" onClick={onEdit} disabled={pending} className={SECONDARY}>
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
    <section className="v2-count">
      <header className="hd">
        <h2>{t.count.saved}</h2>
        <p>{t.count.savedAside(done.placeName, done.lines.length)}</p>
      </header>
      {changed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="v2-lab px-0.5">{t.count.savedChanges}</h3>
          <DiffList lines={changed} />
        </div>
      ) : (
        <p className="note">{t.count.savedNoChanges}</p>
      )}
      <div className="acts">
        <Link href={stockHref} className={PRIMARY}>
          {t.count.toStock}
        </Link>
        {more ? (
          <button type="button" onClick={onAnother} className={SECONDARY}>
            {t.count.countAnother}
          </button>
        ) : null}
      </div>
    </section>
  );
}
