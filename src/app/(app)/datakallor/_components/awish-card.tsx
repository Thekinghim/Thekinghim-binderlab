"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { MobileMore } from "../../_mobil/mobile-more";

import {
  previewAwishPush,
  saveAwishCredentials,
  saveAwishWebCredentials,
  setAwishWebPush,
  syncAwishNow,
  testAwishConnection,
  testAwishWebLogin,
} from "../actions";
import { formatWhen } from "../_lib/display";

export interface AwishCardSource {
  orders: number;
  lastSyncedAt: string | null;
  credentials: { appIdLast4: string; appSecretLast4: string; appKeyLast4: string } | null;
  lastRun: { at: string; ok: boolean; message: string | null } | null;
  historyDone: boolean;
  web: { email: string | null; hasPassword: boolean; enabled: boolean };
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
  const [busy, setBusy] = useState<
    "save" | "test" | "sync" | "web-save" | "web-test" | "web-toggle" | "web-preview" | null
  >(null);
  const [preview, setPreview] = useState<{
    message: string;
    lines: string[];
  } | null>(null);
  // Mobil: förklaringen, Testa inloggningen, Provkör och Ändra inloggning bakom "Mer".
  const [pushMore, setPushMore] = useState(false);
  const fold = pushMore ? "" : "max-md:hidden";
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [appKey, setAppKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const saved = source?.credentials ?? null;
  const web = source?.web ?? { email: null, hasPassword: false, enabled: false };
  const line = statusLine(source, timeZone, new Date(now));

  const run = (
    kind: "save" | "test" | "sync" | "web-save" | "web-test" | "web-toggle" | "web-preview",
    fn: () => Promise<void>,
  ) => {
    setBusy(kind);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  const saveWeb = () =>
    run("web-save", async () => {
      const r = await saveAwishWebCredentials({ email, password });
      if (!r.ok) {
        toast({ title: "Inte sparat", description: r.error, tone: "critical" });
        return;
      }
      setPassword("");
      toast({ title: "Inloggningen sparad", tone: "ok" });
      router.refresh();
    });

  const testWeb = () =>
    run("web-test", async () => {
      const r = await testAwishWebLogin();
      if (!r.ok) {
        setResult(r.error);
        return;
      }
      setResult(r.data.message);
    });

  const previewWeb = () =>
    run("web-preview", async () => {
      const r = await previewAwishPush();
      if (!r.ok) {
        setPreview({ message: r.error, lines: [] });
        return;
      }
      const lines: string[] = [];
      for (const m of r.data.machines) {
        const name = m.code ?? "Automat";
        if (m.error) {
          lines.push(`${name}: ${m.error}`);
          continue;
        }
        if (m.planned.length === 0)
          lines.push(`${name}: ${m.slotsRead} fack lästa, inget att ändra.`);
        for (const p of m.planned) lines.push(`${name}: ${p.titleName} ${p.from} → ${p.to}`);
        if (m.titlesWithoutSlot.length > 0) {
          lines.push(`${name}: inget fack i Awish för ${m.titlesWithoutSlot.join(", ")}`);
        }
      }
      setPreview({ message: r.data.message, lines });
    });

  const togglePush = (next: boolean) =>
    run("web-toggle", async () => {
      const r = await setAwishWebPush(next);
      if (!r.ok) {
        toast({ title: "Gick inte", description: r.error, tone: "critical" });
        return;
      }
      toast({
        title: next ? "Skickar till Awish" : "Skickar inte till Awish",
        tone: "ok",
      });
      router.refresh();
    });

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
          {/* Mobil: Testa bakom "⋯"; Hämta nu är den enda knappen. */}
          <MobileMore label="Fler val för Awish" className="max-md:ml-auto">
            <Button
              type="button"
              variant="secondary"
              loading={busy === "test"}
              disabled={pending}
              onClick={test}
            >
              Testa
            </Button>
          </MobileMore>
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
      {saved ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">Skicka påfyllningar till Awish</h4>
            <p className={cn("text-xs text-subtle", web.hasPassword && fold)}>
              Logga in med ditt Awish-konto, så sätter Binderlab automatens antal i Awish när du
              fyller på. Då slipper du skriva antalet på Awish.
            </p>
          </div>
          {web.hasPassword ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-2 text-sm text-muted">
                <StatusGlyph status={web.enabled ? "ok" : "neutral"} />
                {web.enabled ? "På" : "Av"}
                {web.email ? ` · ${web.email}` : ""}
              </span>
              <Button
                type="button"
                variant={web.enabled ? "secondary" : "primary"}
                loading={busy === "web-toggle"}
                disabled={pending}
                onClick={() => togglePush(!web.enabled)}
              >
                {web.enabled ? "Stäng av" : "Slå på"}
              </Button>
              <span className={cn("flex flex-wrap gap-2 md:contents", fold)}>
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy === "web-test"}
                  disabled={pending}
                  onClick={testWeb}
                >
                  Testa inloggningen
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  loading={busy === "web-preview"}
                  disabled={pending}
                  onClick={previewWeb}
                >
                  Provkör (ändrar inget)
                </Button>
              </span>
              <button
                type="button"
                aria-expanded={pushMore}
                onClick={() => setPushMore((v) => !v)}
                className="inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-fg md:hidden"
              >
                {pushMore ? "Mindre" : "Mer"}
              </button>
            </div>
          ) : null}
          {preview ? (
            <div role="status" className="flex flex-col gap-1 text-sm">
              <p className="text-muted">{preview.message}</p>
              {preview.lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs text-subtle">
                  {preview.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <details
            className={cn("group", web.hasPassword && fold)}
            open={web.hasPassword ? undefined : true}
          >
            <summary
              className={
                web.hasPassword ? "cursor-pointer text-sm text-muted hover:text-fg" : "sr-only"
              }
            >
              {web.hasPassword ? "Ändra inloggning" : "Awish-inloggning"}
            </summary>
            <form
              className="mt-3 grid gap-3 md:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveWeb();
              }}
            >
              <Input
                label="E-post till Awish"
                name="awishEmail"
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={email}
                placeholder={web.email ?? ""}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label="Lösenord till Awish"
                name="awishPassword"
                type="password"
                autoComplete="new-password"
                value={password}
                placeholder={web.hasPassword ? "••••••••" : ""}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-subtle md:col-span-2">
                Samma e-post och lösenord som när du loggar in på Awish. Sparas krypterat och visas
                aldrig igen.
              </p>
              <div className="flex flex-wrap gap-2 md:col-span-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === "web-save"}
                  disabled={pending}
                >
                  Spara inloggning
                </Button>
              </div>
            </form>
          </details>
        </div>
      ) : null}
      {result ? (
        <p role="status" className="text-sm text-muted">
          {result}
        </p>
      ) : null}
    </Panel>
  );
}
