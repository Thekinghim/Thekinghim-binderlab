"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Filnamnet ur Content-Disposition, annars ett standardnamn. */
function fileNameOf(response: Response): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? "binderlab-export.zip";
}

/**
 * "Exportera all data": hämtar ZIP-filen (POST, samma ursprung) och sparar den. Fel
 * (inte ägaren, för många exporter) visas på svenska i stället för en tom sida.
 */
export function ExportDataButton() {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      setError(null);
      let response: Response;
      try {
        response = await fetch("/installningar/export", { method: "POST" });
      } catch {
        setError("Ingen kontakt med servern. Försök igen.");
        return;
      }
      if (!response.ok) {
        setError((await response.text()) || "Exporten misslyckades.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileNameOf(response);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Safari på iPhone behöver länken en stund efter klicket.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast({ title: "Exporten är klar", description: a.download, tone: "ok" });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="primary" iconLeft="download" loading={pending} onClick={run}>
          Exportera all data
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
