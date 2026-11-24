"use client";

import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Field, Select, Textarea } from "@/components/v2/field";
import type { StyrSlot } from "@/server/machine-control/load";

import { executeShipmentAction, previewShipmentAction } from "../actions";
import { ConfirmSheet } from "./confirm";
import { slotText } from "./slots-card";
import { useFlow, type FlowPreview } from "./use-flow";
import { reasonOk } from "./validate";

const SHIPMENT_TEXT =
  "Motorn snurrar och ett pack faller ut. Ingen betalning registreras. Awish kör det bara när automaten är i underhållsläge.";

export function ShipmentCard({
  machineId,
  code,
  slots,
  online,
  versionBlocked,
}: {
  machineId: string;
  code: string;
  slots: StyrSlot[];
  online: boolean | null;
  versionBlocked: boolean;
}) {
  const [slotId, setSlotId] = useState("");
  const [reason, setReason] = useState("");
  const flow = useFlow<FlowPreview & { fingerprint: string; idempotencyKey: string }>();
  const shippable = slots.filter((s) => s.canShip);
  const blocked = online === false || versionBlocked;
  const input = { machineId, productId: slotId };

  return (
    <Card title="Mata ut ett pack" id="mata-ut" className="styr-danger-card">
      <div className="flex flex-col gap-3 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        <p className="ops-p">{SHIPMENT_TEXT}</p>
        {online === false ? (
          <p className="text-v2-sm text-v2-mute">Automaten är offline.</p>
        ) : versionBlocked ? (
          <p className="text-v2-sm text-v2-mute">Pausat tills versionsbytet är bekräftat.</p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Fack" className="min-w-[240px] flex-1">
            {(p) => (
              <Select
                {...p}
                value={slotId}
                disabled={blocked || shippable.length === 0}
                onChange={(e) => setSlotId(e.target.value)}
              >
                <option value="">{shippable.length ? "Välj fack" : "Inga fack med motor"}</option>
                {shippable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {slotText(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            touch
            className="styr-danger-outline"
            disabled={blocked || !slotId}
            onClick={() => flow.start(() => previewShipmentAction(input))}
          >
            Mata ut…
          </Button>
        </div>
      </div>

      <ConfirmSheet
        open={flow.open}
        onOpenChange={(o) => {
          if (!o) setReason("");
          flow.onOpenChange(o);
        }}
        title={`Mata ut ett pack ur ${code}?`}
        description={SHIPMENT_TEXT}
        preview={flow.preview}
        loading={flow.loading}
        error={flow.error}
        pending={flow.pending}
        confirmLabel="Mata ut"
        typedVerb="mata ut"
        danger
        extraValid={reasonOk(reason)}
        onConfirm={({ typed }) =>
          flow.apply((p) =>
            executeShipmentAction(input, {
              fingerprint: p.fingerprint,
              idempotencyKey: p.idempotencyKey,
              typed,
              reason,
            }),
          )
        }
      >
        {flow.preview && !flow.preview.blocking ? (
          <Field label="Varför? (syns i loggen)" hint="Minst 5 tecken.">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
        ) : null}
      </ConfirmSheet>
    </Card>
  );
}
