"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";

import {
  acknowledgeAwishVersionAction,
  setAwishWritesViaAction,
  testAwishEndpoint,
  testAwishSigning,
} from "../awish-api-actions";

type Via = "web" | "api" | "api_then_web";

export type AwishApiCardView =
  | { demo: true }
  | {
      demo: false;
      version: string | null;
      previousVersion: string | null;
      versionSeenAt: string | null;
      versionNeedsAck: boolean;
      endpoint: "tls" | "plain" | null;
      endpointError: string | null;
      signStatus: "unverified" | "ok" | "failed";
      signError: string | null;
      slotWritesVia: Via;
      goodsWritesVia: Via;
      timeZone: string;
    };

const VIA_LABEL: Record<Via, string> = {
  web: "Webbpanelen (som nu)",
  api: "API",
  api_then_web: "API, webbpanelen som reserv",
};

const SIGN_LABEL = { ok: "Fungerar", unverified: "Ej testad", failed: "Fungerar inte" } as const;

function time(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

function Row({ status, children }: { status: Status; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <StatusGlyph status={status} />
      <span>{children}</span>
    </p>
  );
}

export function AwishApiCard({ view }: { view: AwishApiCardView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (view.demo) {
    return (
      <Panel className="flex flex-col gap-2">
        <h3 className="text-v2-md font-[650] text-v2-ink">Awish API</h3>
        <p className="text-sm text-muted">
          Det här är en demo – kopplingar till Awish och andra tjänster är avstängda.
        </p>
      </Panel>
    );
  }

  const run = (kind: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(kind);
    start(async () => {
      try {
        const r = await fn();
        toast({ title: r.message, tone: r.ok ? "ok" : "critical" });
        router.refresh();
      } finally {
        setBusy(null);
      }
    });
  };

  const signReady = view.signStatus === "ok";
  const versionText = view.version
    ? `Version ${view.version}${view.versionSeenAt ? ` · kontrollerad ${time(view.versionSeenAt, view.timeZone)}` : ""}`
    : "Version inte kontrollerad än";

  const select = (label: string, value: Via, onChange: (v: Via) => void) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      <select
        className="bg-v2-card h-10 rounded-md border border-v2-line px-3 text-v2-ink"
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as Via)}
      >
        {(Object.keys(VIA_LABEL) as Via[]).map((v) => (
          <option key={v} value={v}>
            {VIA_LABEL[v]}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Panel className="flex flex-col gap-4" id="awish-api">
      <div className="flex flex-col gap-1">
        <h3 className="text-v2-md font-[650] text-v2-ink">Awish API</h3>
        <Row status={view.versionNeedsAck ? "warning" : view.version ? "ok" : "neutral"}>
          {versionText}
        </Row>
        <Row
          status={
            view.endpoint === "tls" ? "ok" : view.endpoint === "plain" ? "warning" : "neutral"
          }
        >
          Anslutning:{" "}
          {view.endpoint === "tls"
            ? "Krypterad (TLS)"
            : view.endpoint === "plain"
              ? "Okrypterad (reserv)"
              : "Ej testad"}
        </Row>
        <Row
          status={
            view.signStatus === "ok" ? "ok" : view.signStatus === "failed" ? "critical" : "neutral"
          }
        >
          Signering: {SIGN_LABEL[view.signStatus]}
        </Row>
        {view.signStatus === "failed" ? (
          <p className="text-sm text-v2-crit-text">
            Skrivningar via API är pausade; webbpanelen används.
          </p>
        ) : null}
      </div>

      {view.versionNeedsAck ? (
        <div className="flex flex-col gap-2 rounded-md bg-v2-warn-soft p-3 text-sm">
          <p>
            Awish bytte version
            {view.previousVersion ? ` (${view.previousVersion} → ${view.version})` : ""}.
            Kontrollera att facken och antalen ser rätt ut. Mata ut och Stäng av är pausade.
          </p>
          <div>
            <Button
              type="button"
              variant="primary"
              loading={busy === "ack"}
              disabled={pending}
              onClick={() => run("ack", acknowledgeAwishVersionAction)}
            >
              Jag har kontrollerat
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          loading={busy === "endpoint"}
          disabled={pending}
          onClick={() => run("endpoint", testAwishEndpoint)}
        >
          Testa anslutning
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={busy === "sign"}
          disabled={pending}
          onClick={() => run("sign", testAwishSigning)}
        >
          Testa signering
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {select("Påfyllning till Awish", view.slotWritesVia, (slot) =>
          run("slot", () => setAwishWritesViaAction({ slot })),
        )}
        {select("Varor till Awish", view.goodsWritesVia, (goods) =>
          run("goods", () => setAwishWritesViaAction({ goods })),
        )}
      </div>
      {!signReady && (view.slotWritesVia !== "web" || view.goodsWritesVia !== "web") ? (
        <p className="text-sm text-muted">
          API används först när signeringen fungerar. Till dess går allt via webbpanelen.
        </p>
      ) : null}
    </Panel>
  );
}
