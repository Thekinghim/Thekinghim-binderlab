"use client";

import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";

import { REBOOT_TEXT, SHUTDOWN_TEXT } from "@/server/machine-control/texts";

import { controlPowerAction, previewPowerAction } from "../actions";
import { ConfirmSheet } from "./confirm";
import { useFlow, type FlowPreview } from "./use-flow";

type PowerPreview = FlowPreview & { fingerprint: string; idempotencyKey: string };

export function PowerCard({
  machineId,
  code,
  online,
  blocked,
  versionBlocked,
}: {
  machineId: string;
  code: string;
  online: boolean | null;
  /**
   * Inget kan skickas (inloggningen saknas eller signeringen godkänns inte, styrBlocked): båda
   * knapparna är avstängda. Varför står överst på sidan, en gång, med vägen till Datakällor.
   */
  blocked: boolean;
  /**
   * Awish bytte version (inte bekräftat): bara Stäng av är pausad. Omstart kräver inget
   * versionsbyte (guard.ts: den behövs ibland just när något är fel).
   */
  versionBlocked: boolean;
}) {
  // Förhandsvisningen läses från servern: den ger beviset som bekräftelsen kräver.
  const reboot = useFlow<PowerPreview>();
  const shutdown = useFlow<PowerPreview>();
  const [more, setMore] = useState(false);
  const offline = online === false;

  return (
    <Card title="Starta om" id="starta-om">
      <div className="flex flex-col gap-3 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        <p className="ops-p">{REBOOT_TEXT}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            touch
            disabled={offline || blocked}
            onClick={() => reboot.start(() => previewPowerAction({ machineId, method: "REBOOT" }))}
          >
            Starta om automaten
          </Button>
          {offline ? <span className="text-v2-sm text-v2-mute">Automaten är offline.</span> : null}
          <Button
            variant="quiet"
            size="sm"
            touch
            aria-expanded={more}
            aria-controls="styr-mer"
            className="ml-auto"
            onClick={() => setMore((m) => !m)}
          >
            Mer
          </Button>
        </div>
        {more ? (
          <div id="styr-mer" className="styr-danger-zone">
            <p className="text-v2-sm">
              <b>Stäng av.</b> {SHUTDOWN_TEXT}
            </p>
            <Button
              touch
              className="styr-danger-outline"
              disabled={offline || blocked || versionBlocked}
              onClick={() =>
                shutdown.start(() => previewPowerAction({ machineId, method: "SHUTDOWN" }))
              }
            >
              Stäng av…
            </Button>
          </div>
        ) : null}
      </div>

      <ConfirmSheet
        open={reboot.open}
        onOpenChange={reboot.onOpenChange}
        title={`Starta om ${code}?`}
        description={REBOOT_TEXT}
        preview={reboot.preview}
        loading={reboot.loading}
        error={reboot.error}
        pending={reboot.pending}
        confirmLabel="Starta om"
        onConfirm={() =>
          reboot.apply((p) =>
            controlPowerAction({
              machineId,
              method: "REBOOT",
              idempotencyKey: p.idempotencyKey,
              fingerprint: p.fingerprint,
            }),
          )
        }
      />
      <ConfirmSheet
        open={shutdown.open}
        onOpenChange={shutdown.onOpenChange}
        title={`Stäng av ${code}?`}
        description={SHUTDOWN_TEXT}
        preview={shutdown.preview}
        loading={shutdown.loading}
        error={shutdown.error}
        pending={shutdown.pending}
        confirmLabel="Stäng av"
        typedVerb="stänga av"
        danger
        onConfirm={({ typed }) =>
          shutdown.apply((p) =>
            controlPowerAction({
              machineId,
              method: "SHUTDOWN",
              typed,
              idempotencyKey: p.idempotencyKey,
              fingerprint: p.fingerprint,
            }),
          )
        }
      />
    </Card>
  );
}
