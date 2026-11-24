"use client";

import { useState } from "react";

import { Button, ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Field, Input } from "@/components/v2/field";
import { Notice } from "@/components/v2/notice";
import { CLEAR_SCHEDULE_TEXT } from "@/server/machine-control/texts";

import {
  applyPowerScheduleAction,
  clearPowerScheduleAction,
  previewPowerScheduleAction,
} from "../actions";
import { ConfirmSheet } from "./confirm";
import { useFlow, type FlowPreview } from "./use-flow";

const DAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"] as const;

export function ScheduleCard({
  machineId,
  store,
  saved,
  timezoneBlock,
}: {
  machineId: string;
  store: { storeName: string; on: string; off: string } | null;
  saved: { days: string; on: string; off: string; status: "sent" | "failed" | "cleared" } | null;
  /** Spärren när Awish räknar i en annan tidszon, eller null. */
  timezoneBlock: string | null;
}) {
  const start =
    saved && saved.status !== "cleared" ? saved : store ? { ...store, days: "1111111" } : null;
  const [days, setDays] = useState(start?.days ?? "1111111");
  const [on, setOn] = useState(start?.on ?? "10:00");
  const [off, setOff] = useState(start?.off ?? "21:00");
  const send = useFlow<FlowPreview & { fingerprint: string; idempotencyKey: string }>();
  // Ny nyckel varje gång arket öppnas: ett misslyckat försök kan göras om (samma nyckel
  // skulle bara ge "misslyckades redan"), och dubbelklick i samma ark skickas ändå en gång.
  const clear = useFlow<FlowPreview & { idempotencyKey: string }>();
  const input = { machineId, days, on, off };
  const usesStore = store !== null && days === "1111111" && on === store.on && off === store.off;

  function toggle(i: number) {
    setDays((d) => d.slice(0, i) + (d[i] === "1" ? "0" : "1") + d.slice(i + 1));
  }

  return (
    <Card title="Strömschema" id="strom">
      <div className="flex flex-col gap-4 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        {timezoneBlock ? (
          <Notice
            tone="warning"
            title={timezoneBlock}
            action={
              <ButtonLink href="/installningar/awish" size="sm" touch>
                Inställningar → Awish
              </ButtonLink>
            }
          />
        ) : null}
        {store ? (
          <p className="flex flex-wrap items-center gap-2 text-v2-sm">
            <span className="text-v2-mute">
              Butikens tider: {store.on}–{store.off}
            </span>
            {usesStore ? null : (
              <Button
                size="sm"
                touch
                variant="plain"
                onClick={() => {
                  setDays("1111111");
                  setOn(store.on);
                  setOff(store.off);
                }}
              >
                Använd butikens tider
              </Button>
            )}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-v2-sm font-[650]" id="styr-dagar">
            Dagar
          </span>
          <div role="group" aria-labelledby="styr-dagar" className="v2-chips styr-days">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={days[i] === "1"}
                onClick={() => toggle(i)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="grid max-w-[360px] grid-cols-2 gap-3">
          <Field label="På">
            {(p) => (
              <Input
                {...p}
                type="time"
                step={60}
                value={on}
                onChange={(e) => setOn(e.target.value)}
              />
            )}
          </Field>
          <Field label="Av">
            {(p) => (
              <Input
                {...p}
                type="time"
                step={60}
                value={off}
                onChange={(e) => setOff(e.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            touch
            variant="act"
            disabled={Boolean(timezoneBlock) || !days.includes("1") || on === off}
            onClick={() => send.start(() => previewPowerScheduleAction(input))}
          >
            Skicka schema
          </Button>
          {/* Alltid synlig: ett schema kan vara satt i Awishs egen panel. */}
          <Button
            touch
            variant="quiet"
            onClick={() =>
              clear.start({
                lines: [CLEAR_SCHEDULE_TEXT],
                warnings:
                  saved && saved.status !== "cleared"
                    ? []
                    : ["Binderlab har inget sparat schema. Ett schema satt i Awish tas bort."],
                blocking: null,
                confirm: null,
                typed: null,
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            Ta bort schema
          </Button>
        </div>
        {saved?.status === "failed" ? (
          <p className="text-v2-sm text-v2-crit-text">Senaste schemat gick inte fram.</p>
        ) : null}
        <p className="text-v2-xs text-v2-mute">Alla automater stöder inte schema.</p>
      </div>

      <ConfirmSheet
        open={send.open}
        onOpenChange={send.onOpenChange}
        title="Skicka strömschema?"
        preview={send.preview}
        loading={send.loading}
        error={send.error}
        pending={send.pending}
        confirmLabel="Skicka schema"
        typedVerb="skicka schemat"
        danger={Boolean(send.preview?.typed)}
        onConfirm={({ typed }) =>
          send.apply((p) =>
            applyPowerScheduleAction(input, {
              fingerprint: p.fingerprint,
              idempotencyKey: p.idempotencyKey,
              ...(p.typed ? { typed } : {}),
            }),
          )
        }
      />
      <ConfirmSheet
        open={clear.open}
        onOpenChange={clear.onOpenChange}
        title="Ta bort schemat?"
        preview={clear.preview}
        loading={clear.loading}
        error={clear.error}
        pending={clear.pending}
        confirmLabel="Ta bort schema"
        onConfirm={() => clear.apply((p) => clearPowerScheduleAction(machineId, p.idempotencyKey))}
      />
    </Card>
  );
}
