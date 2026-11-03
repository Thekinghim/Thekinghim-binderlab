"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { connectNewMachine, ignoreNewMachine, unignoreNewMachine } from "./actions";

export interface NewMachineCard {
  /** source_machines.id */
  readonly id: string;
  readonly title: string;
  /** Koden automaten får (BL-004). */
  readonly code: string;
  readonly detail: string;
}

/** Värdet i butikslistan som öppnar guiden "Ny butik". */
const NEW_STORE = "__ny";

/**
 * Korten "Ny automat hittad": välj butik och tryck Koppla (ett klick när det bara finns en
 * butik), eller "Ny butik" (guiden) eller "Inte vår" (med Ångra).
 */
export function NewMachineCards({
  cards,
  stores,
}: {
  cards: readonly NewMachineCard[];
  stores: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const visible = cards.filter((c) => !hidden.has(c.id));
  if (visible.length === 0) return null;
  const hide = (id: string, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <section aria-labelledby="nya-automater-rubrik" className="rise mb-8 flex flex-col gap-3">
      <h2 id="nya-automater-rubrik" className="label text-subtle">
        {visible.length === 1
          ? "Ny automat hittad"
          : `${formatInt(visible.length)}${NBSP}nya automater hittade`}
      </h2>
      {visible.map((c, i) => (
        <Card key={c.id} card={c} stores={stores} index={i} onHide={(on) => hide(c.id, on)} />
      ))}
    </section>
  );
}

function Card({
  card,
  stores,
  index,
  onHide,
}: {
  card: NewMachineCard;
  stores: ReadonlyArray<{ id: string; name: string }>;
  index: number;
  onHide: (on: boolean) => void;
}) {
  const toast = useToast();
  const [store, setStore] = useState(stores[0]?.id ?? NEW_STORE);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const options = [
    ...stores.map((s) => ({ value: s.id, label: s.name })),
    { value: NEW_STORE, label: "+ Ny butik" },
  ];
  const storeName = stores.find((s) => s.id === store)?.name ?? "";

  const connect = () => {
    setError(undefined);
    startTransition(async () => {
      const result = await connectNewMachine({ sourceMachineId: card.id, storeId: store });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onHide(true);
      const orders = result.data?.orders ?? 0;
      toast({
        title: `Klart! ${result.data?.code ?? card.code} står i ${storeName}.`,
        description:
          orders > 0 ? `${formatInt(orders)}${NBSP}köp hamnade i butiken.` : "Köpen kommer in här.",
        tone: "ok",
      });
    });
  };

  const ignore = () => {
    onHide(true);
    startTransition(async () => {
      const result = await ignoreNewMachine({ sourceMachineId: card.id });
      if (!result.ok) {
        onHide(false);
        toast({ title: "Gick inte", description: result.error, tone: "critical" });
        return;
      }
      toast({
        title: "Dold",
        description: `${card.title} visas inte här.`,
        tone: "ok",
        duration: 15_000,
        action: {
          label: "Ångra",
          onClick: () =>
            startTransition(async () => {
              const r = await unignoreNewMachine({ sourceMachineId: card.id });
              if (r.ok) onHide(false);
            }),
        },
      });
    });
  };

  return (
    <article
      className="rise grid grid-cols-1 gap-4 rounded-md border border-line-control bg-surface px-4 py-4 md:grid-cols-12 md:items-end"
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="flex min-w-0 flex-col gap-1 md:col-span-5">
        <span className="label text-subtle">Ny automat · blir {card.code}</span>
        <h3 className="text-md font-medium text-fg">{card.title}</h3>
        <p className="text-sm text-muted">{card.detail}</p>
      </div>
      <Select
        label="Butik"
        options={options}
        value={store}
        onChange={(e) => setStore(e.target.value)}
        wrapperClassName="md:col-span-3"
        error={error}
      />
      <div className="flex flex-wrap items-center gap-2 md:col-span-4 md:justify-end">
        {store === NEW_STORE ? (
          <Link
            href={`/butiker/ny?awish=${encodeURIComponent(card.id)}`}
            className={cn(
              "inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover",
            )}
          >
            Ny butik
          </Link>
        ) : (
          <Button variant="primary" onClick={connect} loading={pending}>
            Koppla
          </Button>
        )}
        <Button variant="ghost" onClick={ignore} disabled={pending}>
          Inte vår
        </Button>
      </div>
    </article>
  );
}
