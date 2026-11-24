"use client";

/**
 * Påfyllarens skärm (telefon först, 390 px): tre steg, en rad per pack med förslaget
 * förifyllt, och "Klart – jag har fyllt på" längst ner. Kvitto med Ångra (30 minuter).
 * Inga priser, ingen försäljning: bara antal.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { newClientId } from "@/components/pwa/refill-queue";
import { Button } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import { PackImage } from "@/components/v2/pack-image";
import { Stepper } from "@/components/v2/stepper";
import type { StaffFillData } from "@/server/staff/fill";

import { staffSubmitRefill, staffUndo, type StaffAwish } from "../actions";

interface Done {
  packs: number;
  clientIds: string[];
  awish: StaffAwish;
  warnings: string[];
  undone?: boolean;
}

function startValues(data: StaffFillData): Record<string, number> {
  return Object.fromEntries(data.rows.map((r) => [r.titleId, r.suggested]));
}

function freshIds(data: StaffFillData): Record<string, string> {
  return Object.fromEntries(data.rows.map((r) => [r.titleId, newClientId()]));
}

export function StaffFill({
  data,
  orgId,
  backHref,
}: {
  data: StaffFillData;
  orgId: string;
  backHref: string | null;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>(() => startValues(data));
  // Samma id vid nytt försök (idempotent), nya efter en lyckad påfyllning.
  const [ids, setIds] = useState<Record<string, string>>(() => freshIds(data));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();
  const total = useMemo(() => Object.values(qty).reduce((n, q) => n + q, 0), [qty]);

  const submit = () => {
    setError(null);
    const items = data.rows
      .filter((r) => (qty[r.titleId] ?? 0) > 0)
      .map((r) => ({ clientId: ids[r.titleId]!, titleId: r.titleId, quantity: qty[r.titleId]! }));
    start(async () => {
      const res = await staffSubmitRefill({ orgId, machineId: data.machineId, items });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone({
        packs: res.packs,
        clientIds: res.clientIds,
        awish: res.awish,
        warnings: res.warnings,
      });
      setIds(freshIds(data));
      window.scrollTo({ top: 0 });
    });
  };

  const undo = () => {
    if (!done) return;
    start(async () => {
      const res = await staffUndo({ orgId, clientIds: done.clientIds });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone({ ...done, undone: true });
    });
  };

  const place = data.storeName ?? data.name;

  if (done) {
    return (
      <section className="mt-4 flex flex-col gap-4" aria-live="polite">
        <div className="v2-card">
          <div className="v2-card-body flex flex-col items-center gap-2 py-8 text-center">
            <span
              aria-hidden="true"
              className="grid size-14 place-items-center rounded-full bg-v2-profit-soft text-2xl text-v2-profit-text"
            >
              {done.undone ? "↺" : "✓"}
            </span>
            <h1 className="text-v2-lg font-semibold">
              {done.undone ? "Ångrat" : `Tack! Du har fyllt på ${done.packs} pack.`}
            </h1>
            <p className="text-v2-mute">
              {done.undone
                ? "Påfyllningen är borttagen. Inget mer behöver göras."
                : done.awish === "pushed"
                  ? "Automaten är uppdaterad."
                  : "Sparat. Automaten uppdateras strax."}
            </p>
          </div>
        </div>
        {done.warnings.length > 0 ? (
          <Notice tone="warning" title="Något pack sparades inte">
            {done.warnings[0]}
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="critical" live>
            {error}
          </Notice>
        ) : null}
        {!done.undone ? (
          <Button size="lg" className="w-full" pending={pending} onClick={undo}>
            Ångra (fel antal)
          </Button>
        ) : null}
        <Button
          size="lg"
          variant="act"
          className="w-full"
          onClick={() => {
            setDone(null);
            setError(null);
            router.refresh();
          }}
        >
          Klar
        </Button>
      </section>
    );
  }

  return (
    <section className="mt-2 flex flex-col gap-4">
      <div>
        {backHref ? (
          <Link href={backHref} className="v2-btn quiet touch -ml-2.5 text-v2-mute">
            ← Automater
          </Link>
        ) : null}
        <h1 className="text-v2-lg font-semibold">{place}</h1>
        <p className="text-v2-mute">Automat {data.code}</p>
      </div>

      <ol className="v2-card v2-card-body flex flex-col gap-1.5 text-v2-md">
        <li>
          <b>1.</b> Öppna automaten.
        </li>
        <li>
          <b>2.</b> Lägg i det antal pack som står vid varje pack nedan.
        </li>
        <li>
          <b>3.</b> Tryck <b>Klart</b> när du är färdig.
        </li>
      </ol>

      {data.rows.length === 0 ? (
        <Notice tone="info" title="Inga pack att visa ännu">
          Automaten har inte lästs av än. Försök igen om en stund.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Pack att lägga i">
          {data.rows.map((r) => {
            const q = qty[r.titleId] ?? 0;
            const short = r.storeStock !== null && r.storeStock < q;
            return (
              <li key={r.titleId} className="v2-card">
                <div className="v2-card-body flex items-center gap-3">
                  <PackImage title={r.title} size="s" />
                  <div className="min-w-0 flex-1">
                    <b className="block leading-tight">{r.title}</b>
                    <span className="text-v2-sm text-v2-mute">
                      {r.capacity !== null
                        ? `Finns: ${r.units} av ${r.capacity}`
                        : `Finns: ${r.units}`}
                    </span>
                    {r.storeStock !== null ? (
                      <span className="block text-v2-sm text-v2-mute">
                        I butiken: {r.storeStock}
                      </span>
                    ) : null}
                  </div>
                  <Stepper
                    value={q}
                    onChange={(v) => setQty((prev) => ({ ...prev, [r.titleId]: v }))}
                    min={0}
                    max={500}
                    label={r.title}
                    lessLabel={`Ett mindre: ${r.title}`}
                    moreLabel={`Ett till: ${r.title}`}
                  />
                </div>
                {short ? (
                  <p className="border-t border-v2-line px-4 py-2 text-v2-sm text-v2-warn-text">
                    Butiken har bara {r.storeStock} – lägg i det du har.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <Notice tone="critical" live>
          {error}
        </Notice>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 border-t border-v2-line bg-v2-panel px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-[560px]">
          <Button
            size="lg"
            variant="act"
            className="min-h-12 w-full"
            pending={pending}
            disabled={total === 0}
            onClick={submit}
          >
            {total === 0 ? "Välj antal pack" : `Klart – jag har fyllt på ${total} pack`}
          </Button>
        </div>
      </div>
    </section>
  );
}
