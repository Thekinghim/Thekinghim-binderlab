"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";

import { readyRegistration } from "@/components/pwa/service-worker";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";

import { removePushDevice, savePushDevice, sendTestAlert } from "../actions";

export interface DeviceRow {
  readonly id: string;
  readonly endpoint: string;
  readonly label: string;
  readonly detail: string;
  readonly disabled: boolean;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Support = "unknown" | "supported" | "unsupported" | "denied";

function noopSubscribe(): () => void {
  return () => {};
}

function detectSupport(): Support {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "denied" : "supported";
}

/** Push-enheter: slå på push i den här webbläsaren, stäng av enheter, skicka ett provlarm. */
export function PushDevices({
  publicKey,
  pushConfigured,
  devices,
}: {
  publicKey: string | null;
  pushConfigured: boolean;
  devices: DeviceRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const detected = useSyncExternalStore(noopSubscribe, detectSupport, () => "unknown" as Support);
  const [override, setOverride] = useState<Support | null>(null);
  const support = override ?? detected;
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [results, setResults] = useState<
    { channel: string; status: string; detail: string }[] | null
  >(null);

  useEffect(() => {
    if (detected !== "supported" && detected !== "denied") return;
    void readyRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setCurrentEndpoint(sub?.endpoint ?? null);
    });
  }, [detected]);

  const enable = () =>
    start(async () => {
      if (!publicKey) return;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setOverride(permission === "denied" ? "denied" : "supported");
        toast({ title: "Push tillåts inte i den här webbläsaren", tone: "neutral" });
        return;
      }
      const reg = await readyRegistration();
      if (!reg) {
        toast({ title: "Service workern startade inte. Ladda om sidan.", tone: "critical" });
        return;
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
          toast({ title: res.error ?? "Enheten kunde inte sparas", tone: "critical" });
          return;
        }
        setCurrentEndpoint(sub.endpoint);
        toast({ title: "Push påslaget på den här enheten", tone: "ok" });
        router.refresh();
      } catch {
        toast({ title: "Webbläsaren kunde inte prenumerera på push", tone: "critical" });
      }
    });

  const disable = (d: DeviceRow) =>
    start(async () => {
      if (d.endpoint === currentEndpoint) {
        const reg = await readyRegistration();
        const sub = await reg?.pushManager.getSubscription();
        await sub?.unsubscribe().catch(() => undefined);
        setCurrentEndpoint(null);
      }
      await removePushDevice(d.id);
      toast({ title: "Enheten borttagen", tone: "neutral" });
      router.refresh();
    });

  const test = () =>
    startTest(async () => {
      const r = await sendTestAlert();
      setResults(r.results);
      toast({
        title: r.ok ? "Provlarm skickat" : (r.error ?? "Provlarmet nådde ingen kanal"),
        tone: r.ok ? "ok" : "critical",
      });
    });

  const thisDeviceSaved =
    currentEndpoint !== null && devices.some((d) => d.endpoint === currentEndpoint);

  return (
    <div className="flex flex-col gap-5">
      {!pushConfigured ? (
        <StateMessage
          kind="not-configured"
          compact
          message="Push är inte konfigurerad i den här miljön."
          detail="Larm går med e-post tills push är påslaget."
          diagnostics={[
            { label: "Saknas", value: "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT" },
          ]}
        />
      ) : support === "unsupported" ? (
        <StateMessage
          kind="not-configured"
          compact
          message="Den här webbläsaren kan inte ta emot push."
          detail="På iPhone fungerar push när Binderlab är tillagd på hemskärmen (iOS 16.4 eller senare)."
        />
      ) : support === "denied" ? (
        <StateMessage
          kind="denied"
          compact
          message="Notiser är blockerade för Binderlab i webbläsaren."
          detail="Tillåt notiser i webbläsarens inställningar för sidan och ladda om."
        />
      ) : thisDeviceSaved ? null : (
        <div>
          <Button onClick={enable} loading={busy} disabled={!publicKey || support === "unknown"}>
            Slå på push på den här enheten
          </Button>
        </div>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-muted">Ingen enhet har push påslaget.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-fg">
                  {d.label}
                  {d.endpoint === currentEndpoint ? " · den här enheten" : ""}
                </span>
                <span className="meta text-subtle">{d.detail}</span>
              </div>
              <div className="flex items-center gap-2">
                {d.disabled ? <StatusTag status="offline">Avstängd</StatusTag> : null}
                <Button size="sm" variant="ghost" onClick={() => disable(d)} loading={busy}>
                  Ta bort
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <Button onClick={test} loading={testing}>
            Skicka provlarm till mig
          </Button>
        </div>
        {results ? (
          <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
            {results.map((r) => (
              <li key={r.channel} className="flex flex-wrap items-baseline gap-2">
                <StatusTag
                  status={
                    r.status === "sent" ? "ok" : r.status === "failed" ? "warning" : "neutral"
                  }
                >
                  {r.channel === "push" ? "Push" : r.channel === "email" ? "E-post" : "Sms"}
                </StatusTag>
                <span className="text-muted">{r.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
