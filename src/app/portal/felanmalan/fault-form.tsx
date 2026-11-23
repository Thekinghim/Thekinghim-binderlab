"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/v2/button";
import { MachineGlyph } from "@/components/v2/machine-glyph";
import { cn } from "@/lib/cn";
import type { MachineLook } from "@/lib/machine-look";
import { reportFault, type PortalActionResult } from "@/server/portal/actions";
import { FAULT_KINDS, type FaultKind } from "@/server/portal/faults";
import type { PortalScreenSlot, PortalScreenStatus } from "@/server/portal/screens";

import {
  faultDescription,
  PART_KIND,
  PART_LABEL,
  type MachinePart,
} from "../_components/hero-model";
import { FAULT_SHORT, FaultIcon } from "./fault-icons";

export type FaultMachine = {
  machineId: string;
  code: string;
  name: string;
  look: MachineLook;
  status: PortalScreenStatus;
  slots: readonly PortalScreenSlot[];
};

type Spot = { x: number; y: number; w: number; h: number; side: "l" | "r" };

/**
 * Var på automaten delarna sitter, i ritenheter (MachineGlyph, viewBox 100 × 280).
 * Automaterna har inga synliga fack: man trycker på skärmen, betalningen eller luckan.
 */
const HOTSPOTS: Record<MachineLook, Record<MachinePart, Spot>> = {
  stjarnor: {
    screen: { x: 14, y: 23, w: 72, h: 107, side: "r" },
    hatch: { x: 24, y: 134, w: 26, h: 24, side: "l" },
    payment: { x: 50, y: 134, w: 26, h: 24, side: "r" },
  },
  gul: {
    screen: { x: 25, y: 15, w: 50, h: 92, side: "r" },
    hatch: { x: 16, y: 113, w: 30, h: 33, side: "l" },
    payment: { x: 46, y: 113, w: 38, h: 33, side: "r" },
  },
};

const PARTS: MachinePart[] = ["screen", "payment", "hatch"];

/**
 * Felanmälan i två–tre tryck: vad som är fel (sex rutor), var på automaten (tryck på automaten
 * eller på Skärmen, Betalningen eller Luckan) och Skicka. En del av automaten väljer också
 * felet om inget är valt. Med en automat är den redan vald. Skickas med server action
 * reportFault; databasen kontrollerar att automaten står i butiken och att användaren är
 * butikens.
 */
export function FaultForm({
  storeId,
  machines,
  initialMachineId,
}: {
  storeId: string;
  machines: FaultMachine[];
  initialMachineId?: string;
}) {
  const router = useRouter();
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const [machineId, setMachineId] = useState(
    machines.some((m) => m.machineId === initialMachineId)
      ? initialMachineId!
      : (machines[0]?.machineId ?? ""),
  );
  const [kind, setKind] = useState<FaultKind | "">("");
  const [part, setPart] = useState<MachinePart | null>(null);
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<PortalActionResult | null>(null);

  const error = result && !result.ok ? result : null;
  const descId = `${ids}-desc`;
  const selected = machines.find((m) => m.machineId === machineId) ?? null;

  function pickPart(p: MachinePart) {
    setPart((cur) => (cur === p ? null : p));
    if (kind === "") setKind(PART_KIND[p]);
    setResult(null);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const res = await reportFault({
        storeId,
        machineId,
        kind,
        description: faultDescription(kind, part, description),
      });
      setResult(res);
      if (res.ok) {
        setKind("");
        setPart(null);
        setDescription("");
        router.refresh();
      }
    });
  }

  const step = (n: number, text: string, hint?: string) => (
    <p className="pt-fstep">
      <span aria-hidden className="sn">
        {n}
      </span>
      {text}
      {hint ? <span className="hint">{hint}</span> : null}
    </p>
  );

  return (
    <form onSubmit={submit} className="pt-fform" noValidate>
      <fieldset>
        <legend className="sr-only">Vad är fel?</legend>
        {step(1, "Vad är fel?")}
        <div className="pt-ftiles">
          {FAULT_KINDS.map((k) => (
            <label key={k} className="pt-ft" data-on={kind === k}>
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setResult(null);
                }}
                className="sr-only"
              />
              <span aria-hidden className="fi">
                <FaultIcon kind={k} />
              </span>
              {FAULT_SHORT[k]}
              <span aria-hidden className="okc">
                <Icon name="check" size={12} />
              </span>
            </label>
          ))}
        </div>
        {error?.field === "kind" ? <FieldError text={error.error} /> : null}
      </fieldset>

      <fieldset>
        <legend className="sr-only">Vilken automat, och var på den?</legend>
        {step(
          2,
          machines.length > 1 ? "Vilken automat, och var?" : "Var sitter felet?",
          "Tryck på delen",
        )}
        {machines.length > 1 ? (
          <div className="pt-mpicks">
            {machines.map((m) => (
              <label key={m.machineId} className="pt-mpick" data-on={machineId === m.machineId}>
                <input
                  type="radio"
                  name="machine"
                  value={m.machineId}
                  checked={machineId === m.machineId}
                  onChange={() => {
                    setMachineId(m.machineId);
                    setPart(null);
                    setResult(null);
                  }}
                  className="sr-only"
                />
                <MachineGlyph look={m.look} size="s" status={m.status} decorative />
                <span className="t">
                  <b>{m.code}</b>
                  <span>{m.name}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {selected ? (
          <MachinePicker machine={selected} part={part} onPart={pickPart} />
        ) : (
          <p className="pt-note">Välj automaten ovan.</p>
        )}
        {error?.field === "machine" ? <FieldError text={error.error} /> : null}
      </fieldset>

      <div className="pt-fnote">
        <label htmlFor={descId}>
          Något mer?{" "}
          <span className="font-[450] text-v2-mute">
            {kind === "store_other" ? "(beskriv felet)" : "(valfritt)"}
          </span>
        </label>
        <textarea
          id={descId}
          className="v2-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={900}
          rows={2}
          placeholder="Till exempel: kunden betalade 14:05 men fick inget pack."
          aria-invalid={error?.field === "description" || undefined}
          aria-describedby={error?.field === "description" ? `${descId}-err` : undefined}
        />
        {error?.field === "description" ? (
          <FieldError id={`${descId}-err`} text={error.error} />
        ) : null}
      </div>

      <Button
        type="submit"
        variant="act"
        size="lg"
        pending={pending}
        className="w-full"
        disabled={kind === "" || machineId === ""}
      >
        Skicka felanmälan
      </Button>
      <p role="status" aria-live="polite" className="pt-fstatus">
        {result?.ok ? (
          <span className="text-v2-profit-text">Tack. Felanmälan är skickad.</span>
        ) : error && !error.field ? (
          <FieldError text={error.error} />
        ) : kind === "" || machineId === "" ? (
          <span className="text-v2-mute">
            {kind === "" ? "Välj vad som är fel först." : "Välj automaten."}
          </span>
        ) : null}
      </p>
    </form>
  );
}

function FieldError({ text, id }: { text: string; id?: string }) {
  return (
    <span id={id} className="flex items-center gap-1.5 text-v2-sm text-v2-crit-text">
      <Icon name="alert" size={12} />
      {text}
    </span>
  );
}

/** Automaten stor, med Skärmen, Betalningen och Luckan att trycka på. */
function MachinePicker({
  machine,
  part,
  onPart,
}: {
  machine: FaultMachine;
  part: MachinePart | null;
  onPart: (p: MachinePart) => void;
}) {
  const spots = HOTSPOTS[machine.look];
  return (
    <div className="pt-slotpick">
      <div className="pt-sp-glyph" data-look={machine.look}>
        <MachineGlyph
          look={machine.look}
          size="xl"
          status={machine.status}
          slots={machine.slots}
          decorative
        />
        {PARTS.map((p) => {
          const s = spots[p];
          return (
            <button
              key={p}
              type="button"
              className={cn("pt-hot", `side-${s.side}`)}
              data-part={p}
              aria-pressed={part === p}
              onClick={() => onPart(p)}
              style={{
                left: `${s.x}%`,
                top: `${(s.y / 280) * 100}%`,
                width: `${s.w}%`,
                height: `${(s.h / 280) * 100}%`,
              }}
            >
              <span className="pill">{PART_LABEL[p]}</span>
            </button>
          );
        })}
      </div>
      <div className="pt-sp-sel" aria-live="polite">
        <b>
          {machine.code} · {machine.name}
        </b>
        <span>
          {part ? `${PART_LABEL[part]} är vald.` : "Tryck på skärmen, betalningen eller luckan."}
        </span>
      </div>
    </div>
  );
}
