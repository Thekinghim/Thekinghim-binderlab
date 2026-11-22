"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import { useToast } from "@/components/ui/toast";

import { setVatAcknowledged } from "../_actions/settings";

export interface SettingsNotice {
  readonly kind: "card_fee" | "vat";
  readonly text: string;
}

/**
 * Det appen säger till om överst på Inställningar: kortavgift 0 % trots kortköp och moms
 * 0 % nära momsgränsen. Bara varningar: appen ändrar ingenting själv. Momsraden stängs med
 * "Revisorn har koll"; kortavgiften rättas i formuläret under.
 */
export function SettingsNotices({ notices }: { notices: readonly SettingsNotice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  if (notices.length === 0) return null;

  const acknowledge = () =>
    startTransition(async () => {
      setError(undefined);
      const r = await setVatAcknowledged(true).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({
        title: "Momsvarningen är stängd i år",
        description: "Du kan slå på den igen under Avgifter och moms.",
        tone: "ok",
      });
      router.refresh();
    });

  return (
    <ul className="flex flex-col gap-2" aria-label="Att kolla" data-settings-notices>
      {notices.map((n) => (
        <li key={n.kind} data-settings-notice={n.kind}>
          <Notice
            tone="warning"
            action={
              n.kind === "vat" ? (
                <Button touch pending={pending} onClick={acknowledge}>
                  Revisorn har koll
                </Button>
              ) : (
                <a href="#kortavgift" className="v2-btn touch">
                  Ändra kortavgiften
                </a>
              )
            }
          >
            {n.text}
          </Notice>
        </li>
      ))}
      {error ? (
        <li role="alert">
          <Notice tone="critical">{error}</Notice>
        </li>
      ) : null}
    </ul>
  );
}

/** "Revisorn har koll på momsen." med knappen "Varna igen" (i Avgifter och moms). */
export function VatAcknowledgedLine({ since }: { since: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const warnAgain = () =>
    startTransition(async () => {
      setError(undefined);
      const r = await setVatAcknowledged(false).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2" data-vat-acknowledged>
      <Notice
        tone="info"
        action={
          <Button touch pending={pending} onClick={warnAgain}>
            Varna igen
          </Button>
        }
      >
        Revisorn har koll på momsen sedan {since.replace(/\.$/, "")}. Ingen varning i år.
      </Notice>
      {error ? (
        <p role="alert" className="text-v2-sm text-v2-crit-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
