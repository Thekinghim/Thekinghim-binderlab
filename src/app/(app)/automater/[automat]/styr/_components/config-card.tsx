"use client";

import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Field, Input } from "@/components/v2/field";
import type { AwishMachineConfig } from "@/server/awish/control/types";

import { applyMachineConfigAction, previewMachineConfigAction } from "../actions";
import { ConfirmSheet } from "./confirm";
import { useFlow, type FlowPreview } from "./use-flow";
import { intervalOk, MAX_INTERVAL_S, MIN_INTERVAL_S } from "./validate";

function readOnly(config: AwishMachineConfig | null): string {
  const v = config?.volume;
  const b = config?.brightness;
  const parts = [
    v === null || v === undefined ? null : `Volym ${v}`,
    b === null || b === undefined ? null : `Ljusstyrka ${b}`,
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(" · ")} (ändras på automaten)`
    : "Volym och ljusstyrka ändras på automaten.";
}

export function ConfigCard({
  machineId,
  config,
}: {
  machineId: string;
  config: AwishMachineConfig | null;
}) {
  const [standbyAdsEnabled, setStandby] = useState(config?.standbyAdsEnabled ?? false);
  const [standbyAdsAutoplay, setAutoplay] = useState(config?.standbyAdsAutoplay ?? false);
  const [carouselAdsEnabled, setCarousel] = useState(config?.carouselAdsEnabled ?? false);
  const [standbyInt, setStandbyInt] = useState(String(config?.standbyAdsSwitchInterval || 10));
  const [carouselInt, setCarouselInt] = useState(String(config?.carouselAdsSwitchInterval || 10));
  const flow = useFlow<FlowPreview & { fingerprint: string; idempotencyKey: string }>();
  const valid = intervalOk(standbyInt) && intervalOk(carouselInt);
  const input = {
    machineId,
    standbyAdsEnabled,
    standbyAdsAutoplay,
    carouselAdsEnabled,
    standbyAdsSwitchInterval: Number(standbyInt),
    carouselAdsSwitchInterval: Number(carouselInt),
  };
  const toggles: [string, boolean, (v: boolean) => void][] = [
    ["Reklam i vila", standbyAdsEnabled, setStandby],
    ["Spela upp automatiskt", standbyAdsAutoplay, setAutoplay],
    ["Bildspel", carouselAdsEnabled, setCarousel],
  ];
  const err = `${MIN_INTERVAL_S}–${MAX_INTERVAL_S} s.`;

  return (
    <Card title="Skärm och reklam" id="skarm">
      <div className="flex flex-col gap-4 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        <p className="tnum text-v2-sm text-v2-mute">{readOnly(config)}</p>
        {config === null ? (
          <p className="ops-p">Awish visar inga inställningar för automaten just nu.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {toggles.map(([label, value, set]) => (
                <label key={label} className="flex items-center gap-2 text-v2-sm">
                  <input
                    type="checkbox"
                    role="switch"
                    className="size-4"
                    checked={value}
                    onChange={(e) => set(e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="grid max-w-[420px] grid-cols-2 gap-3">
              <Field label="Byt bild i vila var" error={intervalOk(standbyInt) ? undefined : err}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    suffix="s"
                    value={standbyInt}
                    onChange={(e) => setStandbyInt(e.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Byt bild i bildspelet var"
                error={intervalOk(carouselInt) ? undefined : err}
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    suffix="s"
                    value={carouselInt}
                    onChange={(e) => setCarouselInt(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div>
              <Button
                touch
                variant="act"
                disabled={!valid}
                onClick={() => flow.start(() => previewMachineConfigAction(input))}
              >
                Spara
              </Button>
            </div>
          </>
        )}
      </div>
      <ConfirmSheet
        open={flow.open}
        onOpenChange={flow.onOpenChange}
        title="Spara skärm och reklam?"
        preview={flow.preview}
        loading={flow.loading}
        error={flow.error}
        pending={flow.pending}
        confirmLabel="Spara"
        onConfirm={() =>
          flow.apply((p) =>
            applyMachineConfigAction(input, {
              fingerprint: p.fingerprint,
              idempotencyKey: p.idempotencyKey,
            }),
          )
        }
      />
    </Card>
  );
}
