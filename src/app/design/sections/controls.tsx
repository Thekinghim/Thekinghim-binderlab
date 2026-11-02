"use client";

import { useState, type ReactNode } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatHotkey, useModifierKey } from "@/components/ui/command-palette";
import { Modal, ModalPanel } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { ToastCard, useToast, type ToastInput } from "@/components/ui/toast";
import { formatDateTime, formatInt } from "@/lib/format";
import {
  EMPTY_SLOT,
  machineById,
  machineLabel,
  machineStates,
  machines,
  REF_NOW,
  storeById,
  titles,
} from "../sample-data";
import { SpecSection, Sub } from "./section";

/** Ikonerna med vad de betyder i gränssnittet. */
const icons: ReadonlyArray<[IconName, string]> = [
  ["overview", "Översikt"],
  ["sales", "Försäljning"],
  ["machine", "Automat"],
  ["inventory", "Lager"],
  ["margin", "Marginal"],
  ["report", "Rapport"],
  ["columns", "Kolumner"],
  ["settings", "Inställningar"],
  ["search", "Sök"],
  ["filter", "Filter"],
  ["calendar", "Period"],
  ["download", "Ladda ner"],
  ["print", "Skriv ut"],
  ["alert", "Larm"],
  ["info", "Info"],
  ["check", "Klart"],
  ["close", "Stäng"],
  ["plus", "Lägg till"],
  ["more", "Fler val"],
  ["arrowUpRight", "Öppna"],
  ["sun", "Ljust läge"],
  ["moon", "Mörkt läge"],
];

export const iconNames: IconName[] = icons.map(([name]) => name);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-line py-4 first:pt-0 sm:grid-cols-[128px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <span className="meta text-subtle">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const empty = machineById.get(EMPTY_SLOT.machineId) ?? machines[0];
const emptyTitle = titles.find((t) => t.id === EMPTY_SLOT.titleId);
const emptyLabel = empty ? machineLabel(empty) : "";

// Kvittot gäller BL-001:s senaste påfyllning (30 okt.), inte det tomma facket i BL-002.
const refilled = machines[0];
const refilledAt = machineStates.find((m) => m.machineId === refilled?.id)?.lastRefill;
const refillToast: ToastInput = {
  title: "Påfyllning registrerad",
  description: `24 pack ${titles[0]?.name ?? ""} i fack 2, ${refilled ? machineLabel(refilled) : ""}.`,
  tone: "ok",
  meta: `${refilled?.code ?? ""} · ${refilledAt ? formatDateTime(refilledAt, { now: REF_NOW }) : ""}`,
};
const emptyToast: ToastInput = {
  title: `Fack ${EMPTY_SLOT.slot} är tomt`,
  description: `${emptyLabel} har sålt slut på ${emptyTitle?.name ?? ""}.`,
  tone: "critical",
  meta: `${empty?.code ?? ""} · 31 okt. 16:40`,
};

export function ControlsSection({ index }: { index: number }) {
  const n = String(index).padStart(2, "0");
  const [mode, setMode] = useState<"intakt" | "pack">("intakt");
  const mod = useModifierKey();
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const store = empty ? storeById.get(empty.storeId) : undefined;

  return (
    <SpecSection
      id="kontroller"
      index={index}
      eyebrow="Kontroller"
      title="Höjd 28 eller 36 px, radie 4."
      aside="Fylld signal bara i dialogens sista steg."
    >
      <Sub index={`${n}.1`} label="Knappar" meta="md 36 · sm 28" className="lg:col-span-7">
        <div className="flex flex-col">
          <Row label="md">
            <Button variant="primary">Registrera påfyllning</Button>
            <Button iconLeft="download">Exportera</Button>
            <Button variant="ghost" iconRight="arrowUpRight">
              Öppna
            </Button>
            <Button variant="danger" iconLeft="alert" onClick={() => setOpen(true)}>
              Stoppa automat
            </Button>
          </Row>
          <Row label="sm · laddar">
            <Button size="sm" variant="primary">
              Spara
            </Button>
            <Button size="sm" iconLeft="search" kbd={formatHotkey(mod) || undefined}>
              Sök
            </Button>
            <Button size="sm" loading>
              Synkar
            </Button>
          </Row>
          <Row label="inaktiv">
            <Button size="sm" variant="primary" disabled>
              Spara
            </Button>
            <Button size="sm" disabled>
              Exportera
            </Button>
            <Button size="sm" variant="danger" iconLeft="alert" disabled>
              Stoppa
            </Button>
          </Row>
          <Row label="verktygsrad">
            <IconButton icon="filter" label="Filtrera" />
            <IconButton icon="columns" label="Kolumner" />
            <IconButton icon="download" label="Ladda ner" disabled />
            <IconButton icon="more" label="Fler val" />
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            <Button variant="ghost" size="sm" disabled>
              Ångra
            </Button>
          </Row>
          <Row label="segment">
            <Segmented
              label="Mått i diagrammet"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "intakt", label: "Intäkt" },
                { value: "pack", label: "Pack" },
              ]}
            />
          </Row>
        </div>
      </Sub>

      <Sub index={`${n}.2`} label="Fält och val" meta="36 px" className="lg:col-span-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Input label="Sök automat" placeholder="BL-002, Mobilia …" icon="search" />
          <Input
            label="Inköpspris"
            type="number"
            defaultValue={31}
            suffix="kr"
            hint="30th Celebration, per pack"
          />
          <Input
            label="Påfyllningsgräns"
            type="number"
            defaultValue={5}
            suffix="%"
            error="Måste vara minst 10 %"
          />
          <Input label="Butik" defaultValue="Mobilia" disabled hint="Låst av placeringen" />
          <Select
            label="Automat"
            defaultValue={empty?.id}
            options={machines.map((m) => ({ value: m.id, label: machineLabel(m) }))}
          />
          <Select
            label="Gruppera efter"
            options={[
              { value: "dag", label: "Dag" },
              { value: "vecka", label: "Vecka" },
              { value: "manad", label: "Månad" },
            ]}
          />
        </div>
      </Sub>

      <Sub
        index={`${n}.3`}
        label="Status"
        meta="form + text"
        title="Normalläget är tyst."
        className="lg:col-span-5"
      >
        <ul className="flex flex-col">
          {(
            [
              ["ok", undefined, "BL-001 Nordstan"],
              ["warning", "Fyllnad 17 %", "BL-003 Väla Centrum"],
              ["critical", `Tomt fack ${EMPTY_SLOT.slot}`, emptyLabel],
              ["offline", "Ur drift", "ingen just nu"],
              ["neutral", "Synkad 14:32", "Awish"],
            ] as const
          ).map(([s, text, who]) => (
            <li
              key={s}
              className="flex items-center justify-between gap-3 border-b border-line py-2 first:pt-0"
            >
              <StatusTag status={s}>{text}</StatusTag>
              <span className="meta truncate text-subtle">{who}</span>
            </li>
          ))}
        </ul>
      </Sub>

      <Sub index={`${n}.4`} label="Ikoner" meta="16 px · 1,25 px linje" className="lg:col-span-7">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-y-5">
          {icons.map(([name, text]) => (
            <li key={name} className="flex flex-col items-center gap-2 text-muted">
              <Icon name={name} />
              <span className="text-center text-xs text-subtle">{text}</span>
            </li>
          ))}
        </ul>
      </Sub>

      <Sub
        index={`${n}.5`}
        label="Notis"
        meta="5 s · pausas när pekaren är över"
        className="lg:col-span-6"
      >
        <div className="flex flex-col gap-3 sm:max-w-[380px]">
          <ToastCard item={refillToast} />
          <ToastCard item={emptyToast} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={() => toast(refillToast)}>
              Visa bekräftelse
            </Button>
            <Button size="sm" onClick={() => toast(emptyToast)}>
              Visa kritisk
            </Button>
          </div>
        </div>
      </Sub>

      <Sub index={`${n}.6`} label="Dialog" meta="Esc stänger" className="lg:col-span-6">
        <div className="flex flex-col gap-3 sm:max-w-[420px]">
          {/* Statiskt exempel: inert, så att knapparna varken nås med tangentbord eller skärmläsare. */}
          <div inert>
            <ModalPanel
              eyebrow={`Automat / ${empty?.code ?? ""}`}
              title={`Stoppa ${emptyLabel}?`}
              description="Automaten slutar ta emot köp direkt. Pågående köp avslutas först."
              footer={
                <>
                  <Button size="sm">Avbryt</Button>
                  <Button size="sm" variant="danger-confirm" iconLeft="alert">
                    Stoppa automat
                  </Button>
                </>
              }
            />
          </div>
          <div className="pt-1">
            <Button size="sm" onClick={() => setOpen(true)}>
              Öppna dialogen
            </Button>
          </div>
        </div>
      </Sub>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Automat / ${empty?.code ?? ""}`}
        title={`Stoppa ${emptyLabel}?`}
        description={`Automaten i ${store?.name ?? ""} slutar ta emot köp direkt. ${formatInt(1)} fack är redan tomt.`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Avbryt</Button>
            <Button
              variant="danger-confirm"
              iconLeft="alert"
              onClick={() => {
                setOpen(false);
                toast({
                  title: `${empty?.code ?? ""} har stoppats`,
                  description: "Automaten tar inte emot köp förrän den startas igen.",
                  tone: "critical",
                  meta: "14:32",
                });
              }}
            >
              Stoppa automat
            </Button>
          </>
        }
      />
    </SpecSection>
  );
}
