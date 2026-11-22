"use client";

import { useRouter } from "next/navigation";

import { useRefillQueue } from "@/components/pwa/use-refill-queue";
import { Badge } from "@/components/v2/badge";
import { Button } from "@/components/v2/button";
import { formatInt } from "@/lib/format";

/**
 * Påfyllningar som Fyll på sparat i telefonen utan nät (samma kö och scope som /fyll-pa).
 * Skickas härifrån också när nätet kommer tillbaka; syns bara när något väntar.
 */
export function QueueStatus({ scope }: { scope: string }) {
  const router = useRouter();
  const q = useRefillQueue(scope, { onBackgroundSaved: () => router.refresh() });
  const waiting = q.queue.filter((x) => x.status === "queued");
  const rejected = q.queue.filter((x) => x.status === "rejected");
  if (q.queue.length === 0) return null;
  return (
    <section aria-live="polite" className="v2-card flex flex-col gap-3 px-[18px] py-3.5">
      {waiting.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-v2-md font-[550] text-v2-ink">
            {`${formatInt(waiting.length)} ${waiting.length === 1 ? "påfyllning" : "påfyllningar"} sparas när du får nät.`}
          </p>
          {q.online ? (
            <Button
              size="sm"
              touch
              variant="act"
              pending={q.syncing}
              onClick={async () => {
                const out = await q.sync();
                if (out.saved.length > 0) router.refresh();
              }}
            >
              Skicka nu
            </Button>
          ) : (
            <Badge dot>Inget nät</Badge>
          )}
        </div>
      ) : null}
      {rejected.map((r) => (
        <div key={r.clientId} className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-v2-sm text-v2-mute">
            {`${formatInt(r.quantity)} pack sparades inte: ${r.error ?? "avvisad"}`}
          </p>
          <Button size="sm" touch variant="quiet" onClick={() => void q.remove(r.clientId)}>
            Ta bort
          </Button>
        </div>
      ))}
    </section>
  );
}
