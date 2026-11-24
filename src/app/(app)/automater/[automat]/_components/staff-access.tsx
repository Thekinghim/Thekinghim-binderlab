"use client";

/**
 * Påfyllare i butiken (ägare och admin): lägg till en person med namn och mobilnummer,
 * ge ny PIN-kod, ny QR-kod, stäng av och välj automater. PIN-koden och QR-koden visas bara
 * en gång (de sparas bara som hash). QR-koden sätts på automaten: skanna + PIN-kod loggar in.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Notice } from "@/components/v2/notice";
import type { MachineStaffMember } from "@/server/data/machine-staff";

import {
  createStaffAction,
  resetStaffPinAction,
  rotateStaffQrAction,
  setStaffDisabledAction,
  setStaffMachinesAction,
  type StaffQr,
} from "../staff-actions";

interface MachineOption {
  id: string;
  label: string;
}

interface Shown {
  name: string;
  pin?: string;
  qr?: StaffQr;
  note?: string;
}

const STATUS: Record<MachineStaffMember["status"], string> = {
  active: "Aktiv",
  disabled: "Avstängd",
  locked: "Låst – tryck Ny PIN-kod för att låsa upp",
};

function lastUsed(iso: string | null): string {
  if (!iso) return "Har inte loggat in än";
  return `Senast inloggad ${new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}`;
}

function message(shown: Shown): string {
  const open = shown.qr
    ? `Skanna QR-koden på automaten (eller öppna ${shown.qr.link})`
    : "Skanna QR-koden på automaten";
  return `Hej ${shown.name}! ${open} och skriv PIN-koden ${shown.pin ?? ""}. Välj sedan en egen PIN-kod.`;
}

function printQr(svg: string) {
  const w = window.open("", "_blank", "width=600,height=800");
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>QR för påfyllning</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:32px}svg{width:320px;height:320px}h1{font-size:28px;margin:0 0 8px}p{font-size:18px;margin:8px 0}</style>
<h1>Fyll på automaten</h1><p>1. Skanna QR-koden med mobilkameran.</p><p>2. Skriv din PIN-kod.</p>${svg}<p>Personal i butiken. Fungerar inte? Kontakta ägaren.</p>`);
  w.document.close();
  w.focus();
  w.print();
}

function MachineChecks({
  machines,
  value,
  onChange,
}: {
  machines: MachineOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-v2-sm font-medium">Får fylla på</legend>
      {machines.map((m) => (
        <label key={m.id} className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={value.includes(m.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, m.id] : value.filter((id) => id !== m.id))
            }
          />
          {m.label}
        </label>
      ))}
    </fieldset>
  );
}

export function StaffAccess({
  machineId,
  staff,
  machines,
}: {
  machineId: string;
  staff: MachineStaffMember[];
  machines: MachineOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [chosen, setChosen] = useState<string[]>([machineId]);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<{ userId: string; ids: string[] } | null>(null);

  type Answer = {
    ok: boolean;
    error?: string;
    pin?: string;
    name?: string;
    qr?: StaffQr;
    disabled?: boolean;
  };
  const run = (fn: () => Promise<Answer>, after?: (r: Answer) => void) =>
    start(async () => {
      setError(null);
      let r: Answer;
      try {
        r = await fn();
      } catch {
        setError("Det gick inte just nu. Kolla nätet och försök igen.");
        return;
      }
      if (!r.ok) {
        setError(r.error ?? "Något gick fel. Försök igen.");
        return;
      }
      after?.(r);
      router.refresh();
    });

  const create = () =>
    run(
      () => createStaffAction({ name, phone, machineIds: chosen }),
      (r) => {
        setCopied(false);
        setShown({ name: r.name || name, pin: r.pin, qr: r.qr });
        setAdding(false);
        setName("");
        setPhone("");
        setChosen([machineId]);
      },
    );

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(message(shown));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card
      title="Påfyllare i butiken"
      count={staff.length || null}
      actions={
        !adding ? (
          <Button
            touch
            variant="act"
            onClick={() => {
              setAdding(true);
              setShown(null);
            }}
          >
            Lägg till påfyllare
          </Button>
        ) : undefined
      }
    >
      <CardBody className="flex flex-col gap-4">
        <p className="text-v2-sm text-v2-mute">
          Personal i butiken skannar QR-koden på automaten, skriver sin PIN-kod och ser bara Fyll på
          för sina automater. Inga priser och ingen försäljning.
        </p>

        {error ? (
          <Notice tone="critical" live>
            {error}
          </Notice>
        ) : null}

        {shown ? (
          <div
            className="flex flex-col gap-3 rounded-v2 border border-v2-line p-4"
            aria-live="polite"
          >
            {shown.pin ? (
              <>
                <b>PIN-kod till {shown.name}</b>
                <p className="font-mono text-4xl tracking-[0.3em]" data-testid="staff-pin">
                  {shown.pin}
                </p>
              </>
            ) : (
              <b>Ny QR-kod till {shown.name}</b>
            )}
            <p className="text-v2-sm text-v2-mute">
              {shown.qr
                ? "Visas bara nu. Skriv ut QR-koden och sätt den på automaten. Personen skannar den och skriver PIN-koden."
                : "Visas bara nu. Ge koden till personen. QR-koden på automaten gäller som förut."}
              {shown.qr && !shown.pin ? " Den gamla QR-koden fungerar inte längre." : ""}
              {shown.note ? ` ${shown.note}` : ""}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              {shown.qr ? (
                <div
                  className="bg-white size-36 shrink-0 [&_svg]:size-full"
                  aria-label="QR-kod för inloggning"
                  role="img"
                  data-testid="staff-qr"
                  data-link={shown.qr.link}
                  dangerouslySetInnerHTML={{ __html: shown.qr.svg }}
                />
              ) : null}
              <div className="flex flex-col gap-2">
                {shown.pin ? (
                  <Button touch onClick={copy}>
                    {copied ? "Kopierat" : "Kopiera meddelande"}
                  </Button>
                ) : null}
                {shown.qr ? (
                  <Button touch onClick={() => printQr(shown.qr!.svg)}>
                    Skriv ut QR-koden
                  </Button>
                ) : null}
                <Button touch variant="quiet" onClick={() => setShown(null)}>
                  {shown.pin ? "Jag har skrivit upp koden" : "Stäng"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {adding ? (
          <form
            className="flex flex-col gap-3 rounded-v2 border border-v2-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-v2-sm font-medium">Namn</span>
              <input
                className="v2-input min-h-11"
                name="staff-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-v2-sm font-medium">Mobilnummer</span>
              <input
                className="v2-input min-h-11"
                name="staff-phone"
                type="tel"
                inputMode="tel"
                placeholder="070-123 45 67"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </label>
            <MachineChecks machines={machines} value={chosen} onChange={setChosen} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="act"
                touch
                pending={pending}
                disabled={chosen.length === 0}
              >
                Skapa konto
              </Button>
              <Button touch variant="quiet" onClick={() => setAdding(false)}>
                Avbryt
              </Button>
            </div>
          </form>
        ) : null}

        {staff.length === 0 && !adding && !shown ? (
          <p className="text-v2-sm">Ingen i butiken kan fylla på än.</p>
        ) : null}

        <ul className="flex flex-col divide-y divide-v2-line">
          {staff.map((p) => (
            <li key={p.userId} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <b>{p.name}</b> <span className="text-v2-mute">{p.phoneMasked}</span>
                </span>
                <span className="text-v2-sm">
                  {STATUS[p.status]} ·{" "}
                  <span className="text-v2-mute">{lastUsed(p.lastUsedAt)}</span>
                </span>
              </div>
              {editing?.userId === p.userId ? (
                <div className="flex flex-col gap-2">
                  <MachineChecks
                    machines={machines}
                    value={editing.ids}
                    onChange={(ids) => setEditing({ userId: p.userId, ids })}
                  />
                  <div className="flex gap-2">
                    <Button
                      touch
                      variant="act"
                      pending={pending}
                      disabled={editing.ids.length === 0}
                      onClick={() =>
                        run(
                          () => setStaffMachinesAction(p.userId, editing.ids),
                          () => setEditing(null),
                        )
                      }
                    >
                      Spara automater
                    </Button>
                    <Button touch variant="quiet" onClick={() => setEditing(null)}>
                      Avbryt
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    touch
                    pending={pending}
                    onClick={() =>
                      run(
                        () => resetStaffPinAction(p.userId),
                        (r) => {
                          setCopied(false);
                          setShown({
                            name: p.name,
                            pin: r.pin,
                            note: r.disabled
                              ? "Kontot är avstängt: tryck Slå på för att det ska fungera."
                              : "Telefoner som var inloggade loggas ut.",
                          });
                        },
                      )
                    }
                  >
                    Ny PIN-kod
                  </Button>
                  <Button
                    touch
                    pending={pending}
                    onClick={() =>
                      run(
                        () => rotateStaffQrAction(p.userId),
                        (r) => setShown({ name: p.name, qr: r.qr }),
                      )
                    }
                  >
                    Skriv ut ny QR-kod
                  </Button>
                  <Button
                    touch
                    pending={pending}
                    onClick={() =>
                      run(() => setStaffDisabledAction(p.userId, p.status !== "disabled"))
                    }
                  >
                    {p.status === "disabled" ? "Slå på" : "Stäng av"}
                  </Button>
                  <Button
                    touch
                    variant="quiet"
                    onClick={() => setEditing({ userId: p.userId, ids: [...p.machineIds] })}
                  >
                    Ändra automater
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
