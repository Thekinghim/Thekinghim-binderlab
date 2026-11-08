"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MOBILE_MENU_ITEM, MobileMore } from "@/components/ui/more-menu";
import { cn } from "@/lib/cn";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { parseIsoDate } from "@/components/shell/period-state";
import { addDays, maxDate, type IsoDate } from "@/domain";
import { formatDate } from "@/lib/format";

import {
  createMachine,
  decommissionMachine,
  moveMachine,
  reactivateMachine,
  updateMachine,
} from "../actions";
import type { MachineEditable, StoreOption } from "../_lib/types";

type Result = { ok: true } | { ok: false; error: string };

/** När anropet inte når servern (nätverket, omstart): visas i stället för att sidan kraschar. */
const SEND_FAILED = "Ändringen kunde inte skickas. Kontrollera anslutningen och försök igen.";

/** Formulär i en dialog: Enter skickar, fel visas i dialogen, kvitto som notis. */
function FormDialog({
  open,
  onClose,
  title,
  eyebrow,
  description,
  submitLabel,
  danger,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow: string;
  description?: string;
  submitLabel: string;
  danger?: boolean;
  onSubmit: (data: FormData) => Promise<Result>;
  children: ReactNode;
}) {
  const formId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        const result = await onSubmit(data);
        if (!result.ok) setError(result.error);
      } catch (err) {
        console.warn("[automater] Ändringen kunde inte skickas:", err);
        setError(SEND_FAILED);
      }
    });
  };

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      eyebrow={eyebrow}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} aria-disabled={pending}>
            Avbryt
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={danger ? "danger-confirm" : "primary"}
            loading={pending}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {children}
        {error ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-signal-fg">
            <span aria-hidden className="mt-1.5 inline-block size-2 shrink-0 bg-signal" />
            <span className="text-fg">{error}</span>
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/** "13 okt." (året bara när det inte är i år). */
function dayLabel(iso: IsoDate, today: IsoDate): string {
  const d = parseIsoDate(iso);
  return d ? formatDate(d, { year: "auto", now: parseIsoDate(today) ?? new Date() }) : iso;
}

function text(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Lägg till
// ---------------------------------------------------------------------------

/** Knappen "Lägg till automat" med formulär. Ägare och admin. */
export function AddMachineButton({
  stores,
  today,
  suggestedCode,
}: {
  stores: readonly StoreOption[];
  today: IsoDate;
  suggestedCode: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Lägg till automat
      </Button>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Automater / Ny"
        title="Lägg till automat."
        description="Koden står på automaten och i rapporterna. Butiken kan väljas nu eller senare."
        submitLabel="Lägg till"
        onSubmit={async (data) => {
          const result = await createMachine({
            code: text(data, "code"),
            name: text(data, "name"),
            serial: text(data, "serial"),
            activeFrom: text(data, "activeFrom"),
            storeId: text(data, "storeId"),
          });
          if (!result.ok) return result;
          setOpen(false);
          toast({ title: `${result.data?.code ?? "Automaten"} är tillagd`, tone: "ok" });
          if (result.data) router.push(`/automater/${result.data.code.toLowerCase()}`);
          return { ok: true };
        }}
      >
        {open ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                name="code"
                label="Kod"
                defaultValue={suggestedCode}
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                className="font-mono uppercase"
              />
              <Input name="serial" label="Serienummer" autoComplete="off" maxLength={100} />
            </div>
            <Input
              name="name"
              label="Namn"
              placeholder="Automat 4"
              required
              autoComplete="off"
              maxLength={200}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                name="activeFrom"
                label="Driftstart"
                type="date"
                defaultValue={today}
                required
              />
              <Select
                name="storeId"
                label="Butik"
                defaultValue=""
                options={[
                  { value: "", label: "Ingen butik ännu" },
                  ...stores.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </div>
          </>
        ) : null}
      </FormDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Redigera, flytta, avveckla, återaktivera
// ---------------------------------------------------------------------------

type Dialog = "edit" | "move" | "decommission" | null;

/** Åtgärderna på automatens sida. Ägare och admin. */
export function MachineActions({
  machine,
  stores,
  today,
  storeName,
}: {
  machine: MachineEditable;
  stores: readonly StoreOption[];
  today: IsoDate;
  storeName: string | null;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reactivating, startReactivate] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const close = () => setDialog(null);
  const done = (title: string): Result => {
    setDialog(null);
    toast({ title, tone: "ok", meta: machine.code });
    router.refresh();
    return { ok: true };
  };

  const decommissioned = machine.lifecycle === "decommissioned";
  const otherStores = stores.filter((s) => s.id !== machine.storeId);
  const moveMin = machine.lastPlacementFrom ? addDays(machine.lastPlacementFrom, 1) : undefined;
  const moveDefault = moveMin ? maxDate(moveMin, today) : today;
  const endMin = [machine.activeFrom, machine.lastOrderDate]
    .filter((d): d is IsoDate => d !== null)
    .reduce<IsoDate | undefined>((a, b) => (a === undefined ? b : maxDate(a, b)), undefined);
  const endDefault = endMin ? maxDate(endMin, today) : today;
  // Driftstarten får inte ligga efter första ordern, första placeringen eller sista dagen.
  const editMax = [machine.firstOrderDate, machine.firstPlacementFrom, machine.activeTo]
    .filter((d): d is IsoDate => d !== null)
    .reduce<IsoDate | null>((a, b) => (a === null || b < a ? b : a), null);

  return (
    <div className="flex flex-wrap gap-2" data-print="hide">
      {/* Under md bakom "⋯", så att Avveckla inte ligger ett snedtryck från de andra. */}
      <MobileMore label="Ändra automaten" className="md:flex md:flex-wrap md:gap-2">
        <Button
          variant="secondary"
          size="sm"
          className={MOBILE_MENU_ITEM}
          onClick={() => setDialog("edit")}
        >
          Redigera
        </Button>
        {decommissioned ? (
          <Button
            variant="secondary"
            size="sm"
            className={MOBILE_MENU_ITEM}
            loading={reactivating}
            onClick={() =>
              startReactivate(async () => {
                try {
                  const r = await reactivateMachine({ machineId: machine.id });
                  if (r.ok) done(`${machine.code} är i drift igen`);
                  else toast({ title: r.error, tone: "critical", meta: machine.code });
                } catch (err) {
                  console.warn("[automater] Återaktiveringen kunde inte skickas:", err);
                  toast({ title: SEND_FAILED, tone: "critical", meta: machine.code });
                }
              })
            }
          >
            Återaktivera
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              className={MOBILE_MENU_ITEM}
              onClick={() => setDialog("move")}
              disabled={otherStores.length === 0}
            >
              {machine.storeId ? "Flytta till en annan butik" : "Placera i butik"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className={cn(MOBILE_MENU_ITEM, "max-md:mt-2")}
              onClick={() => setDialog("decommission")}
            >
              Avveckla automaten
            </Button>
          </>
        )}
      </MobileMore>

      <FormDialog
        open={dialog === "edit"}
        onClose={close}
        eyebrow={`Automat / ${machine.code}`}
        title={`Redigera ${machine.code}.`}
        submitLabel="Spara"
        onSubmit={async (data) => {
          const r = await updateMachine({
            machineId: machine.id,
            name: text(data, "name"),
            serial: text(data, "serial"),
            activeFrom: text(data, "activeFrom"),
          });
          return r.ok ? done("Ändringen är sparad") : r;
        }}
      >
        {dialog === "edit" ? (
          <>
            <Input
              name="name"
              label="Namn"
              defaultValue={machine.name}
              required
              autoComplete="off"
              maxLength={200}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                name="serial"
                label="Serienummer"
                defaultValue={machine.serial ?? ""}
                autoComplete="off"
                maxLength={100}
              />
              <Input
                name="activeFrom"
                label="Driftstart"
                type="date"
                defaultValue={machine.activeFrom ?? today}
                max={editMax ?? undefined}
                hint={
                  machine.firstOrderDate
                    ? `Första ordern ${dayLabel(machine.firstOrderDate, today)}`
                    : machine.firstPlacementFrom
                      ? `I butik från ${dayLabel(machine.firstPlacementFrom, today)}`
                      : undefined
                }
                required
              />
            </div>
          </>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog === "move"}
        onClose={close}
        eyebrow={`Automat / ${machine.code}`}
        title={machine.storeId ? `Flytta ${machine.code}.` : `Placera ${machine.code}.`}
        description={
          storeName
            ? `${machine.code} står i ${storeName} i dag. Från flyttdagen räknas försäljningen på den nya butiken.`
            : "Försäljningen räknas på butiken från första dagen."
        }
        submitLabel={machine.storeId ? "Flytta" : "Placera"}
        onSubmit={async (data) => {
          const r = await moveMachine({
            machineId: machine.id,
            storeId: text(data, "storeId"),
            from: text(data, "from"),
            note: text(data, "note"),
          });
          return r.ok
            ? done(machine.storeId ? "Automaten är flyttad" : "Automaten är placerad")
            : r;
        }}
      >
        {dialog === "move" ? (
          <>
            <Select
              name="storeId"
              label="Till butik"
              defaultValue=""
              options={[
                { value: "", label: "Välj butik" },
                ...otherStores.map((s) => ({ value: s.id, label: s.name })),
              ]}
              required
            />
            <Input
              name="from"
              label={machine.storeId ? "Flyttdag" : "Från"}
              type="date"
              defaultValue={moveDefault}
              min={moveMin}
              max={machine.activeTo ?? undefined}
              required
            />
            <Input name="note" label="Anteckning" autoComplete="off" maxLength={500} />
          </>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog === "decommission"}
        onClose={close}
        eyebrow={`Automat / ${machine.code}`}
        title={`Avveckla ${machine.code}?`}
        // "Ur drift" är statusen för en automat som har slutat sälja; det här är något annat.
        description={`Gör det bara när ${machine.code} inte ska användas mer. Den räknas inte efter sista dagen${
          storeName ? ` och lämnar ${storeName}` : ""
        }. Försäljning och lager finns kvar i historiken.`}
        submitLabel="Avveckla"
        danger
        onSubmit={async (data) => {
          const r = await decommissionMachine({
            machineId: machine.id,
            activeTo: text(data, "activeTo"),
          });
          return r.ok ? done(`${machine.code} är avvecklad`) : r;
        }}
      >
        {dialog === "decommission" ? (
          <Input
            name="activeTo"
            label="Sista dag i drift"
            type="date"
            defaultValue={endDefault}
            min={endMin}
            hint={
              machine.lastOrderDate
                ? `Senaste ordern ${dayLabel(machine.lastOrderDate, today)}`
                : undefined
            }
            required
          />
        ) : null}
      </FormDialog>
    </div>
  );
}
