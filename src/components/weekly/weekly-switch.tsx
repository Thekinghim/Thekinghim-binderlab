"use client";

/**
 * Knappen "Veckosammanfattning" (notisen på måndag morgon), på personens språk. Används
 * under Notiser i hela appen och i menyn i den enkla vyn. Läget hämtas när knappen visas
 * (loadWeeklySummarySetting) om det inte skickas med.
 *
 * På: telefonen får först lov att visa notiser (om ingen av personens telefoner har det),
 * sedan sparas valet. Av: valet sparas; telefonens notiser för larm rörs inte.
 */

import { useEffect, useState, useTransition } from "react";

import { savePushDevice } from "@/app/(app)/drift/actions";
import {
  currentPushEndpoint,
  detectPushDevice,
  pushBlock,
  subscribeThisDevice,
  type PushBlock,
} from "@/components/pwa/push-device";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/client";
import type { Messages } from "@/i18n/sv";
import { cn } from "@/lib/cn";
import { useHydrated } from "@/lib/use-hydrated";
import {
  loadWeeklySummarySetting,
  saveWeeklySummarySetting,
  type WeeklySummarySetting,
} from "@/server/actions/weekly-summary";

function blockText(t: Messages, block: PushBlock): string {
  switch (block) {
    case "ios-install":
      return t.week.switchIosInstall;
    case "ios-update":
      return t.week.switchIosUpdate;
    case "denied":
      return t.week.switchDenied;
    default:
      return t.week.switchUnsupported;
  }
}

export function WeeklySwitch({
  initial = null,
  className,
}: {
  /** Läget från servern, om sidan redan har läst det. */
  initial?: WeeklySummarySetting | null;
  className?: string;
}) {
  const t = useT();
  const toast = useToast();
  const [setting, setSetting] = useState<WeeklySummarySetting | null>(initial);
  const [here, setHere] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  // Vad telefonen kan vet bara webbläsaren: raden om "den här telefonen" visas efter hydreringen.
  const hydrated = useHydrated();

  useEffect(() => {
    let alive = true;
    if (!initial) {
      void loadWeeklySummarySetting()
        .then((res) => {
          if (alive && res.ok) setSetting(res.setting);
        })
        .catch(() => undefined);
    }
    void currentPushEndpoint().then((endpoint) => {
      if (alive) setHere(endpoint);
    });
    return () => {
      alive = false;
    };
  }, [initial]);

  if (!setting) return null;
  const hasDevice = setting.endpoints.length > 0;
  // "På" visas bara när en notis faktiskt kan komma fram: valet och minst en telefon.
  const on = setting.on && hasDevice;
  const hereOn = here !== null && setting.endpoints.includes(here);

  /** Ger den här telefonen notiser. Sant när den (nu) är påslagen. */
  const addHere = async (): Promise<boolean> => {
    if (!setting.publicKey) {
      setNote(t.week.switchNotConfigured);
      return false;
    }
    const block = pushBlock(detectPushDevice());
    if (block) {
      setNote(blockText(t, block));
      return false;
    }
    const sub = await subscribeThisDevice(setting.publicKey);
    if (!sub.ok) {
      setNote(
        sub.reason === "denied"
          ? t.week.switchDenied
          : sub.reason === "no-worker"
            ? t.week.switchReload
            : t.week.switchFailed,
      );
      return false;
    }
    const saved = await savePushDevice({
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent: navigator.userAgent.slice(0, 300),
    }).catch(() => ({ ok: false as const }));
    if (!saved.ok) {
      setNote(t.week.switchFailed);
      return false;
    }
    setHere(sub.endpoint);
    setSetting((prev) =>
      prev && !prev.endpoints.includes(sub.endpoint)
        ? { ...prev, endpoints: [...prev.endpoints, sub.endpoint] }
        : prev,
    );
    return true;
  };

  const toggle = () =>
    start(async () => {
      setNote(null);
      const next = !on;
      if (next && !hasDevice && !(await addHere())) return;
      const res = await saveWeeklySummarySetting({ on: next }).catch(() => ({
        ok: false as const,
        error: "",
      }));
      if (!res.ok) {
        toast({ title: t.week.switchFailed, tone: "critical" });
        return;
      }
      setSetting((prev) => (prev ? { ...prev, on: next } : prev));
      toast({
        title: next ? t.week.switchOn : t.week.switchOff,
        tone: next ? "ok" : "neutral",
      });
    });

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p id="vecka-knapp" className="text-lg font-medium text-fg">
            {t.week.switchTitle}
          </p>
          <p className="text-sm text-muted">{t.week.switchHint}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="vecka-knapp"
          onClick={toggle}
          disabled={busy}
          className={cn(
            "relative inline-flex h-11 w-[72px] shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-base ease-instrument disabled:cursor-progress",
            on ? "border-inverse bg-inverse" : "border-line-strong bg-hover",
          )}
        >
          <span className="sr-only">{on ? t.week.switchStateOn : t.week.switchStateOff}</span>
          <span
            aria-hidden
            className={cn(
              "shadow-sm absolute top-1 left-1 size-[34px] rounded-full transition-transform duration-base ease-instrument motion-reduce:transition-none",
              on ? "translate-x-7 bg-on-inverse" : "translate-x-0 bg-surface",
            )}
          />
        </button>
      </div>
      {note ? (
        <p role="alert" className="text-sm text-signal-fg">
          {note}
        </p>
      ) : null}
      {hydrated && on && !hereOn && setting.publicKey && pushBlock(detectPushDevice()) === null ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t.week.switchOtherDevice}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setNote(null);
                await addHere();
              })
            }
            className="min-h-11 self-start rounded-md border border-line-strong bg-surface px-4 text-md font-medium text-fg active:bg-hover disabled:text-disabled"
          >
            {t.week.switchAddHere}
          </button>
        </div>
      ) : null}
    </div>
  );
}
