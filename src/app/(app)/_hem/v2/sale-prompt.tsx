"use client";

/**
 * Hem: "Få notis vid varje försäljning" med ett tryck, för ägaren som inte har slagit på
 * notisen. Samma steg som knappen under Drift → Notiser (lov att visa notiser, telefonen
 * sparas, valet sparas). "Inte nu" döljer rutan i den här webbläsaren.
 * På en iPhone utan Binderlab på hemskärmen står vad som behövs i stället för knappen.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { enableSalePush, thisDeviceHint } from "@/components/sales-push/enable";
import { useToast } from "@/components/ui/toast";
import { Button, ButtonLink } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import { useHydrated } from "@/lib/use-hydrated";

const DISMISS_KEY = "binderlab:salj-notis-dold";

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function SalePrompt({
  publicKey,
  hasDevice,
}: {
  publicKey: string | null;
  /** Personen har redan en telefon med notiser (då behövs inget lov). */
  hasDevice: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const hydrated = useHydrated();
  const [hidden, setHidden] = useState(false);
  const [busy, start] = useTransition();

  // Webbläsarens lägen (dold, iPhone) finns bara efter hydreringen.
  if (!hydrated || hidden || dismissed()) return null;
  const hint = hasDevice ? null : thisDeviceHint();

  const hide = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Privat läge: rutan döljs bara nu.
    }
    setHidden(true);
  };

  const enable = () =>
    start(async () => {
      const res = await enableSalePush({ publicKey, hasDevice });
      if (!res.ok) {
        toast({ title: res.message, tone: "neutral" });
        return;
      }
      setHidden(true);
      toast({ title: "Klart! Du får en notis vid varje försäljning.", tone: "ok" });
      router.refresh();
    });

  return (
    <Notice
      className="o-salj"
      title="Få notis vid varje försäljning"
      action={
        <div className="flex flex-wrap gap-2">
          {hint ? (
            <ButtonLink href="/drift/larm" touch>
              Visa hur
            </ButtonLink>
          ) : (
            <Button variant="act" touch pending={busy} onClick={enable}>
              Slå på
            </Button>
          )}
          <Button variant="quiet" touch onClick={hide} disabled={busy}>
            Inte nu
          </Button>
        </div>
      }
    >
      {hint ?? "Titel, automat och belopp direkt i telefonen."}
    </Notice>
  );
}
