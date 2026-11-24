"use client";

/**
 * Förhandsvisning och bekräftelse för skrivningar till Awish (katalog, medlemmar, kontot).
 * Flödet: knappen hämtar förhandsvisningen (läser bara), dialogen visar vad som händer, och
 * först "bekräfta" skickar med förhandsvisningens fingeravtryck och idempotensnyckel. Ett
 * hinder (blocking) visas och går inte att skicka förbi; en skriven bekräftelse (typed) måste
 * stämma exakt.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Input } from "@/components/v2/field";

export interface PreviewData {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly confirm: string | null;
  readonly typed: string | null;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export interface OutcomeData {
  readonly ok: boolean;
  readonly message: string;
  readonly unknown?: boolean;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const OFFLINE = "Ingen kontakt med servern. Försök igen.";

/** Förhandsvisa → bekräfta → skicka. `payload` är formulärets värden. */
export function usePreviewFlow<P extends Record<string, unknown>>(opts: {
  preview: (payload: P) => Promise<Result<PreviewData>>;
  apply: (
    payload: P & { fingerprint: string; idempotencyKey: string; typed?: string },
  ) => Promise<Result<OutcomeData>>;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [payload, setPayload] = useState<P | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = (p: P) =>
    start(async () => {
      setError(null);
      const r = await opts.preview(p).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        toast({ title: "Det gick inte", description: r.error, tone: "critical" });
        return;
      }
      setPayload(p);
      setPreview(r.data);
    });

  const close = () => {
    if (pending) return;
    setPreview(null);
    setPayload(null);
    setError(null);
  };

  /** `typed`: den skrivna bekräftelsen, när förhandsvisningen kräver en (kontrolleras på servern). */
  const confirm = (typed?: string) =>
    start(async () => {
      if (!preview || !payload) return;
      setError(null);
      const r = await opts
        .apply({
          ...payload,
          fingerprint: preview.fingerprint,
          idempotencyKey: preview.idempotencyKey,
          ...(preview.typed ? { typed: typed ?? "" } : {}),
        })
        .catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (!r.data.ok) {
        // Okänt utfall: dialogen stängs (samma nyckel skulle bara ge samma svar).
        if (r.data.unknown) {
          toast({ title: "Okänt utfall", description: r.data.message, tone: "critical" });
          setPreview(null);
          setPayload(null);
          router.refresh();
          return;
        }
        setError(r.data.message);
        return;
      }
      toast({ title: r.data.message, tone: "ok" });
      setPreview(null);
      setPayload(null);
      opts.onDone?.();
      router.refresh();
    });

  return { open, close, confirm, pending, preview, error };
}

export interface FlowView {
  close(): void;
  confirm(typed?: string): void;
  readonly pending: boolean;
  readonly preview: PreviewData | null;
  readonly error: string | null;
}

/** Dialogen för usePreviewFlow. */
export function PreviewDialog({
  flow,
  title,
  confirmLabel,
  danger = false,
}: {
  flow: FlowView;
  title: string;
  confirmLabel: string;
  danger?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const p = flow.preview;
  const typedOk = !p?.typed || typed.trim() === p.typed;
  const canSend = p !== null && !p.blocking && typedOk;
  const onClose = () => {
    setTyped("");
    flow.close();
  };
  return (
    <Modal
      open={p !== null}
      onClose={onClose}
      size="sm"
      title={title}
      description={p?.confirm ?? undefined}
      footer={
        <>
          <Button variant="ghost" disabled={flow.pending} onClick={onClose}>
            {p?.blocking ? "Stäng" : "Avbryt"}
          </Button>
          {p && !p.blocking ? (
            <Button
              variant={danger ? "danger-confirm" : "primary"}
              loading={flow.pending}
              disabled={!canSend}
              onClick={() => {
                flow.confirm(typed);
                setTyped("");
              }}
            >
              {confirmLabel}
            </Button>
          ) : null}
        </>
      }
    >
      {p ? (
        <div className="flex flex-col gap-3 text-v2-md">
          {p.blocking ? (
            <p className="text-v2-crit-text" role="alert">
              {p.blocking}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {p.lines.map((l, i) => (
                <li key={i} className="break-words">
                  {l}
                </li>
              ))}
            </ul>
          )}
          {!p.blocking && p.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1 text-v2-sm text-v2-mute">
              {p.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          {!p.blocking && p.typed ? (
            <label className="flex flex-col gap-1 text-v2-sm">
              <span>
                Skriv <b>{p.typed}</b> för att bekräfta.
              </span>
              <Input
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
                aria-label={`Skriv ${p.typed}`}
              />
            </label>
          ) : null}
          {flow.error ? (
            <p className="text-v2-sm text-v2-crit-text" role="alert">
              {flow.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
