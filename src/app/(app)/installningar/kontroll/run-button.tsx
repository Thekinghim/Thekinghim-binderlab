"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

import { runSelfCheckNow } from "./actions";

/** "Kör kontrollen nu": kör alla kontroller (några sekunder) och visar resultatet. */
export function RunSelfCheckButton() {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      setError(null);
      const r = await runSelfCheckNow().catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const failed = r.data?.failed ?? 0;
      toast({
        title: failed === 0 ? "Allt stämmer" : `Kontrollen hittade ${failed} fel`,
        tone: failed === 0 ? "ok" : undefined,
      });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="primary" iconLeft="refresh" loading={pending} onClick={run}>
          {pending ? "Kontrollerar…" : "Kör kontrollen nu"}
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
