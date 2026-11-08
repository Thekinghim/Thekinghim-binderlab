"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";

import { readyRegistration } from "@/components/pwa/service-worker";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { savePushDevice } from "../actions";
import { deviceHint, type NoticeDevice } from "./device-hint";
import { saveNotices, sendTestNotice } from "./notice-actions";

export interface NoticeTypeView {
  readonly value: string;
  readonly label: string;
}

const UNKNOWN: NoticeDevice = { push: false, denied: false, ios: false, installed: false };

function noopSubscribe(): () => void {
  return () => {};
}

let cached: NoticeDevice | null = null;
function detect(): NoticeDevice {
  if (cached) return cached;
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  const push = "serviceWorker" in nav && "PushManager" in window && "Notification" in window;
  cached = {
    push,
    denied: push && Notification.permission === "denied",
    ios,
    installed: nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
  };
  return cached;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Notiser i mobilen: en knapp på/av och vilka typer. Sparas direkt, ingen spara-knapp.
 * Visas bara när push är konfigurerad (sidan döljer kortet annars).
 */
export function NoticesCard({
  publicKey,
  initialOn,
  initialTypes,
  types,
  endpoints,
}: {
  publicKey: string | null;
  initialOn: boolean;
  initialTypes: string[];
  types: NoticeTypeView[];
  /** Personens påslagna enheter (push-adresser). */
  endpoints: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const device = useSyncExternalStore(noopSubscribe, detect, () => UNKNOWN);
  const [on, setOn] = useState(initialOn);
  const [chosen, setChosen] = useState<string[]>(initialTypes);
  const [here, setHere] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [testing, startTest] = useTransition();

  useEffect(() => {
    if (!device.push) return;
    void readyRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setHere(sub?.endpoint ?? null);
    });
  }, [device.push]);

  const thisDeviceOn = here !== null && endpoints.includes(here);
  const canHere = device.push && !device.denied && publicKey !== null;
  const hint = deviceHint(device);

  /** Prenumererar den här webbläsaren och sparar enheten. */
  async function subscribeHere(): Promise<boolean> {
    if (!publicKey) return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast({ title: "Notiser tillåts inte. Tillåt dem i inställningarna.", tone: "neutral" });
      return false;
    }
    const reg = await readyRegistration();
    if (!reg) {
      toast({ title: "Ladda om sidan och försök igen.", tone: "critical" });
      return false;
    }
    try {
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }));
      const json = sub.toJSON();
      const res = await savePushDevice({
        endpoint: json.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent.slice(0, 300),
      });
      if (!res.ok) {
        toast({ title: res.error ?? "Det gick inte. Försök igen.", tone: "critical" });
        return false;
      }
      setHere(sub.endpoint);
      return true;
    } catch {
      toast({ title: "Det gick inte. Försök igen.", tone: "critical" });
      return false;
    }
  }

  const toggle = () =>
    start(async () => {
      const next = !on;
      if (next && !thisDeviceOn) {
        if (canHere) {
          if (!(await subscribeHere())) return;
        } else if (endpoints.length === 0) {
          toast({ title: hint ?? "Den här webbläsaren kan inte visa notiser.", tone: "neutral" });
          return;
        }
      }
      setOn(next);
      const res = await saveNotices({ on: next });
      if (!res.ok) {
        setOn(!next);
        toast({ title: res.error, tone: "critical" });
        return;
      }
      toast({
        title: next ? "Notiser på" : "Notiser av",
        tone: next ? "ok" : "neutral",
        ...(next ? {} : { action: { label: "Ångra", onClick: () => undoOff() } }),
      });
      router.refresh();
    });

  const undoOff = () =>
    start(async () => {
      setOn(true);
      const res = await saveNotices({ on: true });
      if (!res.ok) setOn(false);
      router.refresh();
    });

  const addHere = () =>
    start(async () => {
      if (await subscribeHere()) {
        toast({ title: "Klart! Notiser i den här telefonen.", tone: "ok" });
        router.refresh();
      }
    });

  const flip = (value: string) =>
    start(async () => {
      const prev = chosen;
      const next = prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value];
      if (next.length === 0) {
        toast({ title: "Välj minst en typ.", tone: "neutral" });
        return;
      }
      setChosen(next);
      const res = await saveNotices({ types: next });
      if (!res.ok) {
        setChosen(prev);
        toast({ title: res.error, tone: "critical" });
      }
    });

  const test = () =>
    startTest(async () => {
      const res = await sendTestNotice();
      toast({
        title: res.ok ? "Provnotis skickad" : (res.error ?? "Det gick inte."),
        tone: res.ok ? "ok" : "critical",
      });
    });

  return (
    <section
      aria-labelledby="notiser"
      className="flex flex-col gap-5 rounded-sm border border-line-strong bg-surface p-5"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="notiser" className="text-lg font-medium text-fg">
          Notiser i mobilen
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="notiser"
          onClick={toggle}
          disabled={busy}
          className={cn(
            "relative inline-flex h-9 w-16 shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-base ease-instrument disabled:cursor-progress max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1 max-md:before:content-['']",
            on ? "border-inverse bg-inverse" : "border-line-strong bg-hover",
          )}
        >
          <span className="sr-only">{on ? "På" : "Av"}</span>
          <span
            aria-hidden
            className={cn(
              "shadow-sm absolute top-1 left-1 size-7 rounded-full transition-transform duration-base ease-instrument motion-reduce:transition-none",
              on ? "translate-x-7 bg-on-inverse" : "translate-x-0 bg-surface",
            )}
          />
        </button>
      </div>

      {hint ? <p className="text-sm text-muted">{hint}</p> : null}

      {on ? (
        <div className="rise flex flex-col gap-4" style={{ "--i": 0 } as React.CSSProperties}>
          <ul className="flex flex-wrap gap-2" aria-label="Typer">
            {types.map((t) => {
              const checked = chosen.includes(t.value);
              return (
                <li key={t.value}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => flip(t.value)}
                    className={cn(
                      "inline-flex h-11 items-center gap-2 rounded-sm border px-4 text-base transition-[background-color,border-color,color] duration-fast ease-instrument",
                      checked
                        ? "border-fg bg-hover text-fg"
                        : "border-line-strong text-subtle hover:text-muted",
                    )}
                  >
                    <span aria-hidden className="w-3 text-center">
                      {checked ? "✓" : ""}
                    </span>
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            {canHere && !thisDeviceOn ? (
              <Button variant="primary" onClick={addHere} loading={busy}>
                Slå på i den här telefonen
              </Button>
            ) : null}
            {endpoints.length > 0 ? (
              <Button variant="ghost" onClick={test} loading={testing}>
                Skicka en provnotis
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
