"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { saveAwishCredentials, syncAwishNow, testAwishConnection } from "../actions";
import { formatWhen } from "../_lib/display";

export interface AwishCardSource {
  orders: number;
  lastSyncedAt: string | null;
  credentials: { appIdLast4: string; appSecretLast4: string; appKeyLast4: string } | null;
  lastRun: { at: string; ok: boolean; message: string | null } | null;
  historyDone: boolean;
}

/** Kort statusrad: senaste synk, senaste fel och antal order. */
function statusLine(
  source: AwishCardSource | null,
  timeZone: string,
  now: Date,
): { status: Status; text: string } {
  if (!source?.credentials) return { status: "neutral", text: "Inte kopplad." };
  const synced = source.lastSyncedAt
    ? `Hämtat ${formatWhen(source.lastSyncedAt, timeZone, now)}`
    : "Inte hämtat än";
  const orders = `${formatInt(source.orders)} order`;
  if (source.lastRun && !source.lastRun.ok) {
    return {
      status: "critical",
      text: `${source.lastRun.message ?? "Hämtningen misslyckades."} ${synced}.`,
    };
  }
  return {
    status: "ok",
    text: `${synced} · ${orders}${source.historyDone ? "" : " · läser historiken"}.`,
  };
}

/** Sparat värde: de sista tecknen om de finns (bara för långa värden), annars bara punkter. */
const masked = (last4: string | undefined, saved: boolean) =>
  last4 ? `••••${last4}` : saved ? "••••••••" : "";

export function AwishCard({
  source,
  timeZone,
  now,
}: {
  source: AwishCardSource | null;
  timeZone: string;
  now: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"save" | "test" | "sync" | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [appKey, setAppKey] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const saved = source?.credentials ?? null;
  const line = statusLine(source, timeZone, new Date(now));

  const run = (kind: "save" | "test" | "sync", fn: () => Promise<void>) => {
    setBusy(kind);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  const save = () =>
    run("save", async () => {
      const r = await saveAwishCredentials({ appId, appSecret, appKey });
      if (!r.ok) {
        toast({ title: "Inte sparat", description: r.error, tone: "critical" });
        return;
      }
      setAppId("");
      setAppSecret("");
      setAppKey("");
      toast({ title: "Sparat", tone: "ok" });
      router.refresh();
    });

  const test = () =>
    run("test", async () => {
      const r = await testAwishConnection();
      if (!r.ok) {
        setResult(r.error);
        return;
      }
      const d = r.data;
      const newest = d.newestOrder
        ? ` Senaste order ${d.newestOrder.id}${d.newestOrder.payTime ? ` (${d.newestOrder.payTime})` : ""}.`
        : "";
      setResult(
        `Ansluten till ${d.merchantTitle || "Awish"}: ${formatInt(d.machines)} automater, ${
          d.totalOrders === null ? "okänt antal" : formatInt(d.totalOrders)
        } order.${newest}`,
      );
    });

  const sync = () =>
    run("sync", async () => {
      const r = await syncAwishNow();
      if (!r.ok) {
        setResult(r.error);
        router.refresh();
        return;
      }
      setResult(
        r.data.message ??
          `${formatInt(r.data.newOrders)} nya order av ${formatInt(r.data.fetched)} lästa.${
            r.data.historyDone ? "" : " Resten hämtas strax."
          }`,
      );
      router.refresh();
    });

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium">Awish</h3>
        <p className="flex items-center gap-2 text-sm text-muted">
          {line.status === "ok" ? (
            <span
              aria-hidden
              className="live-dot inline-block size-2 shrink-0 rounded-full bg-up text-up"
            />
          ) : (
            <StatusGlyph status={line.status} />
          )}
          <span>{line.text}</span>
        </p>
      </div>
      {saved ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            loading={busy === "sync"}
            disabled={pending}
            onClick={sync}
          >
            Hämta nu
          </Button>
          <Button
            type="button"
            variant="secondary"
            loading={busy === "test"}
            disabled={pending}
            onClick={test}
          >
            Testa
          </Button>
        </div>
      ) : null}
      <details className="group" open={saved ? undefined : true}>
        <summary className={saved ? "cursor-pointer text-sm text-muted hover:text-fg" : "sr-only"}>
          Ändra nycklar
        </summary>
        <form
          className="mt-3 grid gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            label="AppId"
            name="appId"
            autoComplete="off"
            spellCheck={false}
            value={appId}
            placeholder={masked(saved?.appIdLast4, saved !== null)}
            onChange={(e) => setAppId(e.target.value)}
          />
          <Input
            label="AppSecret"
            name="appSecret"
            type="password"
            autoComplete="new-password"
            value={appSecret}
            placeholder={masked(saved?.appSecretLast4, saved !== null)}
            onChange={(e) => setAppSecret(e.target.value)}
          />
          <Input
            label="AppKey"
            name="appKey"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={appKey}
            placeholder={masked(saved?.appKeyLast4, saved !== null)}
            onChange={(e) => setAppKey(e.target.value)}
          />
          <p className="text-xs text-subtle md:col-span-3">
            Finns i Awish under Merchant → Developer Center.
          </p>
          <div className="flex flex-wrap gap-2 md:col-span-3">
            <Button type="submit" variant="primary" loading={busy === "save"} disabled={pending}>
              Spara
            </Button>
          </div>
        </form>
      </details>
      {result ? (
        <p role="status" className="text-sm text-muted">
          {result}
        </p>
      ) : null}
    </Panel>
  );
}
