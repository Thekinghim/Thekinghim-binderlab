"use client";

import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";

import { controlPowerAction } from "../actions";
import { ConfirmSheet } from "./confirm";
import { useFlow, type FlowPreview } from "./use-flow";

const REBOOT_TEXT =
  "Den startar om när ingen har rört skärmen på en minut. Försäljningen stannar ett par minuter.";
const SHUTDOWN_TEXT = "Den går inte att starta på distans. Någon måste slå på den i butiken.";

export function PowerCard({
  machineId,
  code,
  online,
  versionBlocked,
  keys,
}: {
  machineId: string;
  code: string;
  online: boolean | null;
  versionBlocked: boolean;
  keys: { reboot: string; shutdown: string };
}) {
  const reboot = useFlow<FlowPreview>();
  const shutdown = useFlow<FlowPreview>();
  const [more, setMore] = useState(false);
  const offline = online === false;

  return (
    <Card title="Starta om" id="starta-om">
      <div className="flex flex-col gap-3 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        <p className="ops-p">{REBOOT_TEXT}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            touch
            disabled={offline}
            onClick={() =>
              reboot.start({
                lines: [`${code} startar om.`],
                warnings: [],
                blocking: null,
                confirm: null,
                typed: null,
              })
            }
          >
            Starta om automaten
          </Button>
          {offline ? <span className="text-v2-sm text-v2-mute">Automaten är offline.</span> : null}
          <Button
            variant="quiet"
            size="sm"
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
              disabled={offline || versionBlocked}
              onClick={() =>
                shutdown.start({
                  lines: [`${code} stängs av och säljer inget förrän någon slår på den.`],
                  warnings: [],
                  blocking: null,
                  confirm: null,
                  typed: code,
                })
              }
            >
              Stäng av…
            </Button>
            {versionBlocked ? (
              <span className="text-v2-sm text-v2-mute">
                Pausat tills versionsbytet är bekräftat.
              </span>
            ) : null}
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
          reboot.apply(() =>
            controlPowerAction({ machineId, method: "REBOOT", idempotencyKey: keys.reboot }),
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
          shutdown.apply(() =>
            controlPowerAction({
              machineId,
              method: "SHUTDOWN",
              typed,
              idempotencyKey: keys.shutdown,
            }),
          )
        }
      />
    </Card>
  );
}
