"use client";

import { useState } from "react";

import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Field, Select } from "@/components/v2/field";
import { Notice } from "@/components/v2/notice";
import { Stepper } from "@/components/v2/stepper";
import type { StyrSlot } from "@/server/machine-control/load";

import {
  applyReplenishAction,
  applySlotSwapAction,
  previewReplenishAction,
  previewSlotSwapAction,
  slotSwapChoicesAction,
} from "../actions";
import { ConfirmSheet } from "./confirm";
import { useFlow, type FlowPreview } from "./use-flow";

type Keyed = FlowPreview & { fingerprint: string; idempotencyKey: string };

export function slotText(s: Pick<StyrSlot, "name" | "goodName" | "count">): string {
  return `${s.name} · ${s.goodName ?? "tomt"} · ${s.count} st`;
}

export function SlotsCard({
  machineId,
  slots,
  via,
}: {
  machineId: string;
  slots: StyrSlot[];
  via: "web" | "api" | "api_then_web";
}) {
  const [slotId, setSlotId] = useState("");
  const [goodId, setGoodId] = useState("");
  const [count, setCount] = useState(0);
  const [goods, setGoods] = useState<{ id: number; name: string }[] | null>(null);
  const [goodsError, setGoodsError] = useState<string | null>(null);
  const [writeVia, setWriteVia] = useState<"api" | "web">(via === "web" ? "web" : "api");
  const [full, setFull] = useState<string[]>([]);
  const swap = useFlow<Keyed & { unchanged?: boolean }>();
  const fill = useFlow<Keyed>();
  const slot = slots.find((s) => s.id === slotId) ?? null;
  const notFull = slots.filter((s) => s.capacity > 0 && s.count < s.capacity);

  function loadGoods() {
    if (goods) return;
    setGoodsError(null);
    slotSwapChoicesAction(machineId).then(
      (r) => {
        if (r.ok) {
          setGoods(r.data.goods.map((g) => ({ id: g.id, name: g.name })));
          setWriteVia(r.data.via);
        } else setGoodsError(r.error);
      },
      () => setGoodsError("Det gick inte att läsa varorna. Försök igen."),
    );
  }

  const input = { machineId, productId: slotId, goodId, count };

  return (
    <Card title="Byt pack i fack" id="fack">
      <div className="flex flex-col gap-4 px-[18px] pt-3 pb-4 max-[900px]:px-4">
        {slots.length === 0 ? (
          <p className="ops-p">Awish visar inga fack för automaten.</p>
        ) : (
          <>
            <div className="grid gap-3 min-[700px]:grid-cols-2">
              <Field label="Fack">
                {(p) => (
                  <Select
                    {...p}
                    value={slotId}
                    onFocus={loadGoods}
                    onChange={(e) => {
                      const s = slots.find((x) => x.id === e.target.value);
                      setSlotId(e.target.value);
                      setCount(s?.count ?? 0);
                      loadGoods();
                    }}
                  >
                    <option value="">Välj fack</option>
                    {slots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {slotText(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Vara" error={goodsError ?? undefined}>
                {(p) => (
                  <Select
                    {...p}
                    value={goodId}
                    disabled={!goods}
                    onFocus={loadGoods}
                    onChange={(e) => setGoodId(e.target.value)}
                  >
                    <option value="">{goods ? "Välj vara" : "Läser varor…"}</option>
                    {(goods ?? []).map((g) => (
                      <option key={g.id} value={String(g.id)}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-v2-sm font-[650]">Antal</span>
                <Stepper
                  value={count}
                  onChange={setCount}
                  min={0}
                  max={slot?.capacity && slot.capacity > 0 ? slot.capacity : 999}
                  label="Antal i facket"
                  inputId="styr-antal"
                />
              </div>
              <Button
                touch
                variant="act"
                disabled={!slotId || !goodId}
                onClick={() => swap.start(() => previewSlotSwapAction(input))}
              >
                Förhandsgranska
              </Button>
              <span className="text-v2-xs text-v2-mute">
                {writeVia === "api" ? "Skickas via API" : "Skickas via webbpanelen"}
              </span>
            </div>

            <div className="flex flex-col gap-2 border-t border-v2-line2 pt-3">
              <h3 className="text-v2-sm font-[650]">Fyll facken fullt</h3>
              {notFull.length === 0 ? (
                <p className="text-v2-sm text-v2-mute">Alla fack är fulla.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {notFull.map((s) => (
                      <label key={s.id} className="tnum flex items-center gap-2 text-v2-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={full.includes(s.id)}
                          onChange={(e) =>
                            setFull((f) =>
                              e.target.checked ? [...f, s.id] : f.filter((x) => x !== s.id),
                            )
                          }
                        />
                        {s.name} {s.count}/{s.capacity}
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      touch
                      disabled={full.length === 0}
                      onClick={() =>
                        fill.start(() => previewReplenishAction({ machineId, productIds: full }))
                      }
                    >
                      Fyll valda fullt
                    </Button>
                    <Button touch variant="quiet" onClick={() => setFull(notFull.map((s) => s.id))}>
                      Välj alla
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        {via === "api_then_web" ? (
          <Notice tone="info">Går API:t inte fram används webbpanelen vid påfyllning.</Notice>
        ) : null}
      </div>

      <ConfirmSheet
        open={swap.open}
        onOpenChange={swap.onOpenChange}
        title="Byt pack i facket?"
        preview={swap.preview}
        loading={swap.loading}
        error={swap.error}
        pending={swap.pending}
        confirmLabel={swap.preview?.unchanged ? "Stäng" : "Skicka till Awish"}
        onConfirm={({ confirmed }) => {
          if (swap.preview?.unchanged) return swap.onOpenChange(false);
          swap.apply((p) =>
            applySlotSwapAction(input, {
              fingerprint: p.fingerprint,
              idempotencyKey: p.idempotencyKey,
              confirmed,
            }),
          );
        }}
      />
      <ConfirmSheet
        open={fill.open}
        onOpenChange={fill.onOpenChange}
        title="Fyll facken fullt?"
        preview={fill.preview}
        loading={fill.loading}
        error={fill.error}
        pending={fill.pending}
        confirmLabel="Fyll fullt"
        onConfirm={() =>
          fill.apply((p) =>
            applyReplenishAction(
              { machineId, productIds: full },
              { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
            ),
          )
        }
      />
    </Card>
  );
}
