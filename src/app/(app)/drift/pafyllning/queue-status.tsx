"use client";

import { useRouter } from "next/navigation";

import { useRefillQueue } from "@/components/pwa/use-refill-queue";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
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
    <section
      aria-live="polite"
      className="flex animate-enter flex-col gap-3 rounded-md border border-line-strong p-4"
    >
      {waiting.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-base text-fg">
            {`${formatInt(waiting.length)} ${waiting.length === 1 ? "påfyllning" : "påfyllningar"} sparas när du får nät.`}
          </p>
          {q.online ? (
            <Button
              size="sm"
              loading={q.syncing}
              onClick={async () => {
                const out = await q.sync();
                if (out.saved.length > 0) router.refresh();
              }}
            >
              Skicka nu
            </Button>
          ) : (
            <StatusTag status="offline">Inget nät</StatusTag>
          )}
        </div>
      ) : null}
      {rejected.map((r) => (
        <div key={r.clientId} className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {`${formatInt(r.quantity)} pack sparades inte: ${r.error ?? "avvisad"}`}
          </p>
          <Button size="sm" variant="ghost" onClick={() => void q.remove(r.clientId)}>
            Ta bort
          </Button>
        </div>
      ))}
    </section>
  );
}
