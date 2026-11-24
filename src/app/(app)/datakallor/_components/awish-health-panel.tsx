"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { formatInt } from "@/lib/format";

import { syncAwishNow, testAwishFallback } from "../actions";
import type { AwishHealthPanelData } from "../_lib/awish-health-load";
import type { AwishHealthState } from "../_lib/awish-health";

const GLYPH: Readonly<Record<AwishHealthState, Status>> = {
  ok: "ok",
  fallback: "warning",
  stale: "warning",
  broken: "critical",
};

/**
 * "Om Awish krånglar" i Datakällor: en rad per väg till Awish (Fungerar, Reservväg:
 * webbpanelen, Senast kända, Fungerar inte sedan) med senaste felet på enkel svenska, och de
 * tre sakerna ägaren själv kan göra: Synka nu, Testa reservvägen och ladda upp orderlistan.
 */
export function AwishHealthPanel({ data }: { data: AwishHealthPanelData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"sync" | "fallback" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const run = (kind: "sync" | "fallback", fn: () => Promise<void>) => {
    setBusy(kind);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
        router.refresh();
      }
    });
  };

  const sync = () =>
    run("sync", async () => {
      const r = await syncAwishNow();
      setResult(
        r.ok ? (r.data.message ?? `Synkat: ${formatInt(r.data.newOrders)} nya order.`) : r.error,
      );
    });

  const testFallback = () =>
    run("fallback", async () => {
      const r = await testAwishFallback();
      setResult(r.ok ? r.data.message : r.error);
    });

  const tone: Status =
    data.summary.tone === "ok" ? "ok" : data.summary.tone === "warn" ? "warning" : "critical";

  return (
    <Panel className="flex flex-col gap-3" data-awish-health={data.summary.tone}>
      <div className="flex flex-col gap-1">
        <h3 id="awish-halsa" className="scroll-mt-24 text-v2-md font-[650] text-v2-ink">
          Om Awish krånglar
        </h3>
        <p className="flex items-center gap-2 text-sm text-muted">
          <StatusGlyph status={tone} />
          <span>
            {data.summary.text}
            {data.pushPending > 0
              ? ` · ${data.pushPending === 1 ? "en automat väntar" : `${formatInt(data.pushPending)} automater väntar`} på Awish`
              : ""}
          </span>
        </p>
      </div>
      {data.rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {data.rows.map((r) => (
            <li
              key={r.key}
              className="flex flex-col gap-0.5 py-2 first:pt-0"
              data-path={r.path}
              data-state={r.state}
            >
              <span className="flex flex-wrap items-center justify-between gap-x-3 text-sm">
                <span className="text-fg">{r.label}</span>
                <span className="flex items-center gap-2 text-muted">
                  <StatusGlyph status={GLYPH[r.state]} />
                  {r.text}
                </span>
              </span>
              {r.error ? <span className="text-xs text-subtle">{r.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Inget hämtat från Awish än.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          loading={busy === "sync"}
          disabled={pending}
          onClick={sync}
        >
          Synka nu
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={busy === "fallback"}
          disabled={pending}
          onClick={testFallback}
        >
          Testa reservvägen
        </Button>
        <a
          href="#ladda-upp"
          className="inline-flex min-h-11 items-center px-2 text-sm text-muted underline underline-offset-4 hover:text-fg"
        >
          Ladda upp orderlistan
        </a>
      </div>
      <p className="text-xs text-subtle">
        Svarar inte Open API läser Binderlab facken via webbpanelen. Orderna har ingen reservväg:
        ladda upp orderlistan från Awish, så hämtar Binderlab resten när Awish svarar igen.
      </p>
      {result ? (
        <p role="status" className="text-sm text-muted">
          {result}
        </p>
      ) : null}
    </Panel>
  );
}
