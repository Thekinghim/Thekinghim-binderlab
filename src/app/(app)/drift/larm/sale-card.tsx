"use client";

/**
 * Notis vid varje försäljning (Drift → Notiser): personens egen knapp på/av och "Tyst på
 * natten". Av som standard. Sparas direkt, ingen spara-knapp.
 *
 * På: den här telefonen får först lov att visa notiser (om ingen av personens telefoner har
 * det), sedan sparas valet. Av: valet sparas; telefonens notiser för larm rörs inte.
 * På iPhone fungerar push bara från hemskärmen: raden säger det.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { currentPushEndpoint } from "@/components/pwa/push-device";
import { enableSalePush, subscribeHere, thisDeviceHint } from "@/components/sales-push/enable";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useHydrated } from "@/lib/use-hydrated";
import { saveSalePushSetting, type SalePushSetting } from "@/server/actions/sale-push";

export function SaleCard({ initial }: { initial: SalePushSetting }) {
  const router = useRouter();
  const toast = useToast();
  const hydrated = useHydrated();
  const [setting, setSetting] = useState<SalePushSetting>(initial);
  const [here, setHere] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    let alive = true;
    void currentPushEndpoint().then((endpoint) => {
      if (alive) setHere(endpoint);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hasDevice = setting.endpoints.length > 0;
  // "På" visas bara när en notis faktiskt kan komma fram: valet och minst en telefon.
  const on = setting.on && hasDevice;
  const hereOn = here !== null && setting.endpoints.includes(here);
  const hint = hydrated ? thisDeviceHint() : null;

  const toggle = () =>
    start(async () => {
      const next = !on;
      if (next) {
        const res = await enableSalePush({ publicKey: setting.publicKey, hasDevice });
        if (!res.ok) {
          toast({ title: res.message, tone: "neutral" });
          return;
        }
        if (res.endpoint) setHere(res.endpoint);
        setSetting((prev) => ({
          ...prev,
          on: true,
          endpoints:
            res.endpoint && !prev.endpoints.includes(res.endpoint)
              ? [...prev.endpoints, res.endpoint]
              : prev.endpoints,
        }));
        toast({ title: "Du får en notis vid varje försäljning", tone: "ok" });
      } else {
        const res = await saveSalePushSetting({ on: false }).catch(() => ({
          ok: false as const,
          error: "Det gick inte att spara. Försök igen.",
        }));
        if (!res.ok) {
          toast({ title: res.error, tone: "critical" });
          return;
        }
        setSetting((prev) => ({ ...prev, on: false }));
        toast({ title: "Notis vid försäljning av", tone: "neutral" });
      }
      router.refresh();
    });

  const flipQuiet = () =>
    start(async () => {
      const next = !setting.quiet;
      setSetting((prev) => ({ ...prev, quiet: next }));
      const res = await saveSalePushSetting({ quiet: next }).catch(() => ({
        ok: false as const,
        error: "Det gick inte att spara. Försök igen.",
      }));
      if (!res.ok) {
        setSetting((prev) => ({ ...prev, quiet: !next }));
        toast({ title: res.error, tone: "critical" });
      }
    });

  const addHere = () =>
    start(async () => {
      if (!setting.publicKey) return;
      const res = await subscribeHere(setting.publicKey);
      if (!res.ok) {
        toast({ title: res.message, tone: "neutral" });
        return;
      }
      setHere(res.endpoint);
      setSetting((prev) =>
        prev.endpoints.includes(res.endpoint)
          ? prev
          : { ...prev, endpoints: [...prev.endpoints, res.endpoint] },
      );
      toast({ title: "Klart! Notiser i den här telefonen.", tone: "ok" });
      router.refresh();
    });

  return (
    <section aria-labelledby="salj-notis" className="v2-card">
      <div className="v2-card-hd">
        <h2 id="salj-notis">Notis vid varje försäljning</h2>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="salj-notis"
          onClick={toggle}
          disabled={busy}
          className="ops-switch"
        >
          <span className="sr-only">{on ? "På" : "Av"}</span>
          <i aria-hidden="true" />
        </button>
      </div>
      <div className="v2-card-body flex flex-col gap-3">
        <p className="ops-p">
          {setting.economy
            ? "Titel, automat, butik och belopp när något säljs."
            : "Titel och automat när något säljs. Inga belopp."}
        </p>
        {hint ? <p className="ops-p">{hint}</p> : null}
        {on ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-v2-sm font-[550] text-v2-ink">Tyst på natten</span>
                <span className="text-v2-xs text-v2-mute">Inga notiser 22–07.</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={setting.quiet}
                aria-label="Tyst på natten"
                onClick={flipQuiet}
                disabled={busy}
                className="ops-switch"
              >
                <span className="sr-only">{setting.quiet ? "På" : "Av"}</span>
                <i aria-hidden="true" />
              </button>
            </label>
            {hydrated && !hereOn && !hint && setting.publicKey ? (
              <div className="flex flex-col gap-2">
                <p className="ops-p">Den här telefonen får inga notiser än.</p>
                <Button variant="primary" onClick={addHere} loading={busy} className="w-fit">
                  Slå på i den här telefonen
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
