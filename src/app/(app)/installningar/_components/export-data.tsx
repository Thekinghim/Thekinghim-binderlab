"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fileNameFrom, saveFile } from "@/components/v2/save-file";

/**
 * "Exportera all data": hämtar ZIP-filen (POST, samma ursprung) och sparar den (på telefonen
 * via delningsarket, saveFile). Fel (inte ägaren, för många exporter) visas på svenska i
 * stället för en tom sida.
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
      const name = fileNameFrom(
        response.headers.get("content-disposition"),
        "binderlab-export.zip",
      );
      const saved = await saveFile(await response.blob(), name);
      if (saved === "saved") toast({ title: "Exporten är klar", description: name, tone: "ok" });
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
        <p role="alert" className="text-v2-sm text-v2-crit-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
