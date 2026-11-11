import Link from "next/link";
import { Fragment } from "react";

import type { Messages } from "@/i18n";

import { countHref, minusFix, packInPlaceHref, type Place } from "../_lib/model";

/**
 * Saldot per lager och i automaterna ("Kontoret 0 · I automaterna 9"). Ett minus visas i
 * signalfärgen, och under raden står vad som rättar det: "Packa 1 omgång nu" när minuset är
 * hela omgångar (någon har fyllt på utan att trycka Packa), annars en länk till
 * inventeringen av lagret. Den som inte får räkna om lagret (påfyllaren) ser bara texten.
 */
export function StockLine({
  titleId,
  places,
  inPlaces,
  inMachines,
  batchSize,
  canPack,
  canCount,
  t,
}: {
  titleId: string;
  places: readonly Place[];
  inPlaces: Readonly<Record<string, number>>;
  inMachines: number;
  /** Pack per omgång, null utan innehåll. */
  batchSize: number | null;
  canPack: boolean;
  /** Får räkna om lagret (ägare och admin). */
  canCount: boolean;
  t: Messages;
}) {
  const m = t.r2.t1.mystery;
  const minus = places
    .map((p) => ({ place: p, quantity: inPlaces[p.id] ?? 0 }))
    .filter((x) => x.quantity < 0)
    .map((x) => ({ ...x, fix: minusFix(x.quantity, batchSize) }));
  return (
    <div className="flex flex-col gap-2">
      <p className="tnum text-base text-muted">
        {places.map((p) => {
          const n = inPlaces[p.id] ?? 0;
          return (
            <Fragment key={p.id}>
              <span className={n < 0 ? "font-medium text-signal-fg" : undefined}>
                {t.mystery.stockIn(t.common.placeName(p.name), n)}
              </span>
              {" · "}
            </Fragment>
          );
        })}
        {t.mystery.inMachines(inMachines)}
      </p>
      {minus.map(({ place, quantity, fix }) => (
        <div
          key={place.id}
          role="note"
          className="flex flex-col gap-2 rounded-md border border-signal-line p-3"
        >
          <p className="text-base text-signal-fg">{m.minus(quantity, place.name)}</p>
          {fix?.kind === "pack" && canPack ? (
            <Link
              href={packInPlaceHref(titleId, place.id, fix.packs)}
              className="inline-flex min-h-11 w-fit items-center rounded-sm border border-line-strong bg-surface px-4 text-base font-medium text-fg hover:bg-hover"
            >
              {m.packNow(fix.batches)}
            </Link>
          ) : canCount ? (
            <Link
              href={countHref(place.id)}
              className="inline-flex min-h-11 w-fit items-center rounded-sm border border-line-strong bg-surface px-4 text-base font-medium text-fg hover:bg-hover"
            >
              {m.countNow}
            </Link>
          ) : (
            <p className="text-base text-muted">{m.askOwnerCount}</p>
          )}
        </div>
      ))}
    </div>
  );
}
