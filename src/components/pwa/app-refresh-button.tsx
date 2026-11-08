"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { fetchLiveBuildId, loadedBuildId, refreshApp } from "./refresh-app";

/** Uppdatera appen nu (även om ingen ny version hittats); null eller ett felmeddelande. */
function useRefresh(): { busy: boolean; error: string | null; run: () => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await refreshApp({ from: loadedBuildId(), to: await fetchLiveBuildId(3000) });
    if (!res.ok) {
      setBusy(false);
      setError("Ingen uppkoppling. Försök igen med nät.");
    }
  };
  return { busy, error, run };
}

/** "Uppdatera appen" i Mer (mobilen): en rad med förklaring. */
export function AppRefreshRow({ className }: { className?: string }) {
  const { busy, error, run } = useRefresh();
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left text-base text-muted transition-colors hover:text-fg focus-visible:-outline-offset-2",
        className,
      )}
    >
      <Icon name="refresh" />
      <span className="flex flex-col">
        {busy ? "Uppdaterar…" : "Uppdatera appen"}
        <span className="text-xs text-subtle">{error ?? "Om något ser gammalt ut"}</span>
      </span>
    </button>
  );
}

/** "Uppdatera appen" i Inställningar. */
export function AppRefreshButton() {
  const { busy, error, run } = useRefresh();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button iconLeft="refresh" loading={busy} onClick={() => void run()}>
          Uppdatera appen
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
