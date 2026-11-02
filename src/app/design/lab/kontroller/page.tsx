"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Icon, type IconName } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { KpiSkeleton, Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

const ICONS: IconName[] = [
  "overview",
  "sales",
  "machine",
  "inventory",
  "margin",
  "settings",
  "sun",
  "moon",
  "more",
  "search",
  "filter",
  "alert",
  "info",
  "report",
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="label text-subtle">{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Board({ theme }: { theme: "dark" | "light" }) {
  const [period, setPeriod] = useState("30d");
  const [mode, setMode] = useState("intakt");
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <div data-theme={theme} className="flex flex-col gap-8 p-4 md:p-6" data-board={theme}>
      <p className="label text-fg">{theme === "dark" ? "Mörkt" : "Ljust"}</p>
      <Row label="Knappar">
        <Button variant="primary">Fyll på automat</Button>
        <Button iconLeft="download">Exportera</Button>
        <Button variant="ghost" iconRight="arrowUpRight">
          Öppna
        </Button>
        <Button variant="danger" iconLeft="alert" onClick={() => setOpen(true)}>
          Stoppa automat
        </Button>
      </Row>
      <Row label="Små · laddar · inaktiv">
        <Button size="sm" variant="primary">
          Spara
        </Button>
        <Button size="sm" kbd="⌘K" iconLeft="search">
          Sök
        </Button>
        <Button size="sm" loading>
          Synkar
        </Button>
        <Button size="sm" disabled>
          Inaktiv
        </Button>
        <Button size="sm" variant="primary" disabled>
          Spara
        </Button>
        <Button size="sm" variant="danger" disabled iconLeft="alert">
          Stoppa
        </Button>
      </Row>
      <Row label="Ikonknappar">
        <IconButton icon="plus" label="Lägg till" variant="secondary" />
        <IconButton icon="filter" label="Filtrera" variant="secondary" />
        <IconButton icon="more" label="Fler val" />
        <IconButton icon="settings" label="Inställningar" size="sm" />
        <IconButton icon="download" label="Ladda ner" variant="secondary" disabled />
      </Row>
      <Row label="Verktygsrad · ghost · en inaktiv">
        <IconButton icon="filter" label="Filtrera" />
        <IconButton icon="download" label="Ladda ner" disabled />
        <IconButton icon="settings" label="Inställningar" />
        <Button variant="ghost" size="sm" disabled>
          Ångra
        </Button>
      </Row>
      <Row label="Segmentväljare">
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "idag", label: "Idag" },
            { value: "7d", label: "7 d" },
            { value: "30d", label: "30 d" },
            { value: "90d", label: "90 d" },
            { value: "atd", label: "ÅTD" },
          ]}
        />
        <Segmented
          label="Diagramläge"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "intakt", label: "Intäkt" },
            { value: "jamfor", label: "Jämför" },
          ]}
        />
      </Row>
      <div className="flex flex-col gap-3">
        <p className="label text-subtle">Ikoner · 16 px · 1.25 linje</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-y-4">
          {ICONS.map((n) => (
            <div key={n} className="flex flex-col items-center gap-2 text-muted">
              <Icon name={n} />
              <span className="meta text-subtle">{n}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Sök automat" placeholder="BL-001, Nordstan …" icon="search" />
        <Input
          label="Inköpspris"
          type="number"
          defaultValue={42}
          suffix="kr"
          hint="Per pack, exkl. moms"
        />
        <Input label="Påfyllningstakt" type="number" defaultValue={128} suffix="st/h" />
        <Input
          id={`larm-${theme}`}
          label="Larmgräns lager"
          type="number"
          defaultValue={4}
          suffix="%"
          error="Måste vara minst 5 %"
        />
        <Input label="Platsnamn" defaultValue="Westfield Arninge" disabled hint="Låst av import" />
        <Select
          label="Gruppera efter"
          options={[
            { value: "dag", label: "Dag" },
            { value: "vecka", label: "Vecka" },
          ]}
        />
        <Select
          label="Automat"
          disabled
          options={[{ value: "bl10", label: "BL-010 · Westfield Arninge" }]}
        />
      </div>
      <Row label="Notis">
        <Button
          size="sm"
          onClick={() =>
            toast({
              title: "Påfyllning registrerad",
              description: "12 pack lades i fack 3.",
              meta: "BL-014 · 14:32",
              tone: "ok",
              duration: 60000,
            })
          }
        >
          Visa notis
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() =>
            toast({
              title: "BL-014 har stoppats",
              description: "Automaten tar inte emot köp förrän den startas igen.",
              meta: "14:32",
              tone: "critical",
              action: { label: "Ångra", onClick: () => {} },
              duration: 60000,
            })
          }
        >
          Kritisk notis
        </Button>
      </Row>
      <div className="grid gap-4 sm:grid-cols-2">
        <KpiSkeleton />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Automat / BL-014"
        title="Stoppa BL-014 Kista Galleria?"
        description="Automaten slutar ta emot köp direkt. Pågående köp avslutas först."
        size="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Avbryt</Button>
            <Button variant="danger-confirm" iconLeft="alert" onClick={() => setOpen(false)}>
              Stoppa automat
            </Button>
          </>
        }
      />
    </div>
  );
}

export default function Page() {
  // Labbet ritas bara i klienten så att skärmbilder alltid visar senaste modulen.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  if (!mounted) return null;
  return (
    <div className="grid lg:grid-cols-2">
      <Board theme="dark" />
      <Board theme="light" />
    </div>
  );
}
