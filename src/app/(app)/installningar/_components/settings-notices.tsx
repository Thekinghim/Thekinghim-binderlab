"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
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
        title: "Momsvarningen är stängd",
        description: "Du kan slå på den igen under Avgifter och moms.",
        tone: "ok",
      });
      router.refresh();
    });

  return (
    <ul className="rise flex flex-col gap-3" aria-label="Att kolla" data-settings-notices>
      {notices.map((n) => (
        <li
          key={n.kind}
          data-settings-notice={n.kind}
          className="flex flex-col gap-3 rounded-sm border border-signal-line bg-surface px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-6"
        >
          <p className="min-w-0 text-base text-fg">{n.text}</p>
          {n.kind === "vat" ? (
            <Button
              variant="secondary"
              className="min-h-11 shrink-0 max-md:w-full"
              loading={pending}
              onClick={acknowledge}
            >
              Revisorn har koll
            </Button>
          ) : (
            <a
              href="#kortavgift"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg hover:bg-hover max-md:w-full"
            >
              Ändra kortavgiften
            </a>
          )}
        </li>
      ))}
      {error ? (
        <li role="alert" className="text-sm text-signal-fg">
          {error}
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
    <div className="flex max-w-2xl flex-col gap-2" data-vat-acknowledged>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-muted">
          Revisorn har koll på momsen sedan {since.replace(/\.$/, "")}. Ingen varning visas.
        </p>
        <Button variant="secondary" className="min-h-11" loading={pending} onClick={warnAgain}>
          Varna igen
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
