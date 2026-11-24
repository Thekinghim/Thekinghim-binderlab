"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toastV2 } from "@/components/v2/toast";

import type { ActionResult } from "../actions";
import type { PreviewView } from "./confirm";

export type FlowPreview = PreviewView & { fingerprint?: string; idempotencyKey?: string };

/**
 * Förhandsvisa → bekräfta → skicka. Arket öppnas direkt, förhandsvisningen läses från
 * servern (eller ges direkt), och svaret visas som en notis. Ett fel stannar i arket.
 */
export function useFlow<P extends FlowPreview>() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<P | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  return {
    open,
    preview,
    loading,
    error,
    pending,
    onOpenChange(o: boolean) {
      setOpen(o);
      if (!o) reset();
    },
    /** Öppnar arket och läser förhandsvisningen. */
    start(load: P | (() => Promise<ActionResult<P>>)) {
      reset();
      setOpen(true);
      if (typeof load !== "function") {
        setPreview(load);
        return;
      }
      setLoading(true);
      load().then(
        (res) => {
          setLoading(false);
          if (res.ok) setPreview(res.data);
          else setError(res.error);
        },
        () => {
          setLoading(false);
          setError("Det gick inte att läsa från Awish. Försök igen.");
        },
      );
    },
    /** Skickar; stänger arket och visar notisen vid lyckat svar. */
    apply(send: (p: P) => Promise<ActionResult<{ message: string }>>) {
      const p = preview;
      if (!p) return;
      setError(null);
      startTransition(async () => {
        try {
          const res = await send(p);
          if (res.ok) {
            setOpen(false);
            reset();
            toastV2(res.data.message, { tone: "success" });
            router.refresh();
          } else {
            setError(res.error);
          }
        } catch {
          setError("Vi vet inte om Awish fick det. Titta på automaten innan du försöker igen.");
        }
      });
    },
  };
}
