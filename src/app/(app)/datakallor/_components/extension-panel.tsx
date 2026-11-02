"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";
import { createExtensionSource, createSyncToken, revokeSyncToken } from "@/server/ingest/actions";
import type { ExtensionSourceView, SyncTokenView } from "@/server/ingest/manage";

import { SOURCE_TIMEZONES } from "../_lib/constants";
import { formatWhen } from "../_lib/display";

const LOGGED_OUT_HINT = "Logga in på dash.awish.vip i Chrome så fortsätter synken.";

/** Källans läge, i första hand efter tilläggets senaste kontakt. */
function sourceStatus(source: ExtensionSourceView): { status: Status; text: string } {
  if (source.archived) return { status: "offline", text: "Arkiverad" };
  if (source.status === "paused") return { status: "offline", text: "Pausad" };
  const active = source.tokens.filter((t) => !t.revokedAt);
  if (active.length === 0) return { status: "neutral", text: "Ingen token" };
  const seen = active.filter((t) => t.lastSeenAt);
  if (seen.length === 0) return { status: "neutral", text: "Väntar på första synk" };
  if (seen.some((t) => t.lastStatus === "logged_out")) {
    return { status: "warning", text: "Utloggad från Awish" };
  }
  if (source.silent) return { status: "critical", text: "Tyst > 2 h" };
  if (seen.some((t) => t.lastStatus === "error") || source.failedLast24h > 0) {
    return { status: "warning", text: "Fel" };
  }
  return { status: "ok", text: "Synkar" };
}

function tokenStatus(token: SyncTokenView): { status: Status; text: string } {
  if (token.revokedAt) return { status: "offline", text: "Återkallad" };
  if (!token.lastSeenAt) return { status: "neutral", text: "Inte använd" };
  if (token.lastStatus === "logged_out") return { status: "warning", text: "Utloggad" };
  if (token.lastStatus === "error") return { status: "warning", text: "Fel" };
  return { status: "ok", text: "Aktiv" };
}

const linkButton =
  "relative inline-flex h-9 select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse transition-[background-color,border-color,color] duration-fast ease-instrument hover:border-inverse-hover hover:bg-inverse-hover";

export function ExtensionPanel({
  sources,
  timeZone,
  now,
  appUrl,
  zipPath,
  silenceMinutes,
}: {
  sources: readonly ExtensionSourceView[];
  timeZone: string;
  now: string;
  appUrl: string;
  zipPath: string;
  silenceMinutes: number;
}) {
  const [sourceDialog, setSourceDialog] = useState({ key: 0, open: false });
  const [tokenDialog, setTokenDialog] = useState<{
    key: number;
    open: boolean;
    source: ExtensionSourceView | null;
  }>({ key: 0, open: false, source: null });
  const [revoke, setRevoke] = useState<{ key: number; open: boolean; token: SyncTokenView | null }>(
    { key: 0, open: false, token: null },
  );
  const nowDate = new Date(now);
  const active = sources.filter((s) => !s.archived);

  return (
    <div className="flex flex-col gap-6">
      {active.length === 0 ? (
        <StateMessage
          kind="not-configured"
          message="Ingen datakälla för tillägget ännu."
          detail="Skapa en datakälla av typen Awish-tillägg och en token, och installera sedan tillägget i Chrome enligt stegen nedan."
          action={
            <Button
              variant="primary"
              iconLeft="plus"
              onClick={() => setSourceDialog((d) => ({ key: d.key + 1, open: true }))}
            >
              Skapa datakälla för tillägget
            </Button>
          }
          className="rounded-md border border-line bg-surface"
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Datakällor för Chrome-tillägget">
          {active.map((s) => {
            const st = sourceStatus(s);
            const loggedOut = s.tokens.some((t) => !t.revokedAt && t.lastStatus === "logged_out");
            const errors = s.tokens
              .filter((t) => !t.revokedAt && t.lastStatus === "error" && t.lastError)
              .map((t) => t.lastError as string);
            return (
              <li key={s.id}>
                <Panel className="flex min-w-0 flex-col gap-5">
                  <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-12">
                    <div className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-4">
                      <p className="truncate text-md font-medium text-fg">{s.name}</p>
                      <p className="label text-subtle">Awish · Chrome-tillägg</p>
                    </div>
                    <Fact label="Status" className="md:col-span-2">
                      <StatusTag status={st.status}>{st.text}</StatusTag>
                    </Fact>
                    <Fact label="Senast synkad" className="md:col-span-2">
                      <span className="tnum">
                        {s.tokens.some((t) => t.lastSeenAt)
                          ? formatWhen(s.lastSyncedAt, timeZone, nowDate)
                          : "Inte än"}
                      </span>
                    </Fact>
                    <Fact label="Nya senaste dygnet" className="md:col-span-2">
                      <span className="tnum">{formatInt(s.newLast24h)}</span>
                    </Fact>
                    <Fact label="Fel senaste dygnet" className="md:col-span-2">
                      <span className="tnum">
                        {s.failedLast24h + s.errorRowsLast24h === 0
                          ? "Inga"
                          : [
                              s.failedLast24h > 0
                                ? `${formatInt(s.failedLast24h)} misslyckade`
                                : null,
                              s.errorRowsLast24h > 0 ? `${formatInt(s.errorRowsLast24h)} rader` : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                      </span>
                    </Fact>
                  </div>

                  {loggedOut ? (
                    <p role="status" className="flex items-start gap-2 text-sm text-fg">
                      <Icon name="alert" size={14} />
                      {LOGGED_OUT_HINT}
                    </p>
                  ) : null}
                  {s.silent && !loggedOut ? (
                    <p role="status" className="flex items-start gap-2 text-sm text-fg">
                      <Icon name="alert" size={14} />
                      Tillägget har inte rapporterat på över {Math.round(silenceMinutes / 60)}{" "}
                      timmar. Kontrollera att Chrome är öppet på datorn med tillägget och att du är
                      inloggad på dash.awish.vip.
                    </p>
                  ) : null}
                  {errors.length > 0 ? (
                    <p className="text-sm text-muted">Senaste fel: {errors[0]}</p>
                  ) : null}

                  <div className="flex flex-col gap-3 border-t border-line pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="label text-subtle">
                        Tokens · {s.tokens.filter((t) => !t.revokedAt).length} aktiva
                      </p>
                      <Button
                        size="sm"
                        iconLeft="plus"
                        onClick={() =>
                          setTokenDialog((d) => ({ key: d.key + 1, open: true, source: s }))
                        }
                      >
                        Skapa token
                      </Button>
                    </div>
                    {s.tokens.length === 0 ? (
                      <p className="text-sm text-muted">
                        Ingen token. Skapa en och klistra in den i tillägget.
                      </p>
                    ) : (
                      <ul className="flex flex-col divide-y divide-line" aria-label={`Tokens för ${s.name}`}>
                        {s.tokens.map((t) => {
                          const ts = tokenStatus(t);
                          return (
                            <li
                              key={t.id}
                              className="grid grid-cols-2 items-center gap-x-4 gap-y-1 py-2 md:grid-cols-12"
                            >
                              <span className="col-span-2 min-w-0 truncate text-base text-fg md:col-span-3">
                                {t.name}
                              </span>
                              <code className="label truncate text-muted md:col-span-2">
                                {t.prefix}…
                              </code>
                              <span className="md:col-span-2">
                                <StatusTag status={ts.status}>{ts.text}</StatusTag>
                              </span>
                              <span className="col-span-2 truncate text-sm text-muted md:col-span-4">
                                {t.revokedAt
                                  ? `Återkallad ${formatWhen(t.revokedAt, timeZone, nowDate)}`
                                  : t.lastSeenAt
                                    ? `Senast ${formatWhen(t.lastSeenAt, timeZone, nowDate)}${t.clientVersion ? ` · v${t.clientVersion}` : ""}`
                                    : `Skapad ${formatWhen(t.createdAt, timeZone, nowDate)}${t.createdBy ? ` av ${t.createdBy}` : ""}`}
                              </span>
                              <span className="col-span-2 flex md:col-span-1 md:justify-end">
                                {!t.revokedAt ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`Återkalla ${t.name}`}
                                    onClick={() =>
                                      setRevoke((r) => ({ key: r.key + 1, open: true, token: t }))
                                    }
                                  >
                                    Återkalla
                                  </Button>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </Panel>
              </li>
            );
          })}
        </ul>
      )}

      <InstallGuide appUrl={appUrl} zipPath={zipPath} />

      {active.length > 0 ? (
        <div>
          <Button
            size="sm"
            iconLeft="plus"
            onClick={() => setSourceDialog((d) => ({ key: d.key + 1, open: true }))}
          >
            Ny datakälla för tillägget
          </Button>
        </div>
      ) : null}

      <SourceDialog
        key={`s${sourceDialog.key}`}
        open={sourceDialog.open}
        onClose={() => setSourceDialog((d) => ({ ...d, open: false }))}
      />
      <TokenDialog
        key={`t${tokenDialog.key}`}
        open={tokenDialog.open}
        source={tokenDialog.source}
        appUrl={appUrl}
        onClose={() => setTokenDialog((d) => ({ ...d, open: false }))}
      />
      <RevokeDialog
        key={`r${revoke.key}`}
        open={revoke.open}
        token={revoke.token}
        onClose={() => setRevoke((r) => ({ ...r, open: false }))}
      />
    </div>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="label text-subtle">{label}</span>
      <span className="flex min-w-0 text-base text-fg">{children}</span>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      iconLeft={copied ? "check" : undefined}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Kopierad" : "Kopiera"}
    </Button>
  );
}

/** Installationen i fyra steg. */
function InstallGuide({ appUrl, zipPath }: { appUrl: string; zipPath: string }) {
  return (
    <Panel className="flex flex-col gap-4">
      <p className="label text-subtle">Installera tillägget · 4 steg</p>
      <ol className="flex flex-col gap-4">
        <Step n={1} title="Ladda ner tillägget">
          <p className="text-sm text-muted">
            En zip-fil med tillägget. Packa upp den i en mapp som du behåller (t.ex. Dokument).
          </p>
          <div>
            <a href={zipPath} download className={linkButton}>
              <Icon name="download" size={16} />
              Ladda ner binderlab-awish-sync.zip
            </a>
          </div>
        </Step>
        <Step n={2} title="Läs in det i Chrome">
          <p className="text-sm text-muted">
            Öppna <code className="label text-fg">chrome://extensions</code>, slå på{" "}
            <span className="text-fg">Utvecklarläge</span> uppe till höger, klicka{" "}
            <span className="text-fg">Läs in okomprimerat</span> och välj den uppackade mappen.
          </p>
          <div className="flex items-center gap-2">
            <CopyButton value="chrome://extensions" label="Kopiera chrome://extensions" />
          </div>
        </Step>
        <Step n={3} title="Klistra in adress och token">
          <p className="text-sm text-muted">
            Klicka på Binderlab-ikonen i Chrome. Klistra in Binderlabs adress och en token som du
            skapar ovan (den visas bara en gång).
          </p>
          {appUrl ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="label min-w-0 truncate rounded-sm border border-line bg-bg px-2 py-1 text-fg">
                {appUrl}
              </code>
              <CopyButton value={appUrl} label="Kopiera Binderlabs adress" />
            </div>
          ) : null}
        </Step>
        <Step n={4} title="Klart">
          <p className="text-sm text-muted">
            Var inloggad på dash.awish.vip i Chrome. Tillägget läser hela historiken första
            gången (en sida i sekunden) och sedan nya ordrar var tionde minut, så länge Chrome är
            öppet. Statusen syns här och i tillägget.
          </p>
        </Step>
      </ol>
    </Panel>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-x-3">
      <span className="label tnum text-subtle">{String(n).padStart(2, "0")}</span>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-base font-medium text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}

function SourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("Awish via Chrome-tillägg");
  const [zone, setZone] = useState("Asia/Shanghai");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await createExtensionSource({ name, sourceTimezone: zone });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: "Datakällan är skapad",
        description: "Skapa en token och klistra in den i tillägget.",
        tone: "ok",
      });
      onClose();
      router.refresh();
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Ny datakälla"
      title="Awish via Chrome-tillägget"
      description="Ordrarna som tillägget skickar hamnar i den här källan. Använd inte samma Awish-konto i en CSV-källa samtidigt, då blir orderna dubbla."
      footer={
        <>
          <Button onClick={onClose}>Avbryt</Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Skapa
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Namn" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
        <Select
          label="Källans tidszon"
          value={zone}
          options={SOURCE_TIMEZONES.map((z) => ({ value: z.value, label: z.label }))}
          onChange={(e) => setZone(e.target.value)}
          hint="Tiden som Awish visar Payment Time i. Shanghai tills det kontrollerats mot order 42780 (docs/awish.md)."
        />
        {error ? (
          <p role="alert" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function TokenDialog({
  open,
  source,
  appUrl,
  onClose,
}: {
  open: boolean;
  source: ExtensionSourceView | null;
  appUrl: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("Kontorsdatorn");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const close = () => {
    if (token) router.refresh();
    setToken(null);
    onClose();
  };

  const submit = () =>
    startTransition(async () => {
      if (!source) return;
      setError(null);
      const result = await createSyncToken({ dataSourceId: source.id, name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setToken(result.data.token);
    });

  return (
    <Modal
      open={open}
      onClose={close}
      eyebrow={source ? `Token / ${source.name}` : "Token"}
      title={token ? "Kopiera token nu" : "Ny token för tillägget"}
      description={
        token
          ? "Token visas bara den här gången. Klistra in den i tillägget tillsammans med adressen."
          : "En token per dator med tillägget. Den kan bara skicka ordrar till den här datakällan och kan återkallas."
      }
      footer={
        token ? (
          <Button variant="primary" onClick={close}>
            Klar
          </Button>
        ) : (
          <>
            <Button onClick={close}>Avbryt</Button>
            <Button variant="primary" loading={pending} onClick={submit}>
              Skapa token
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="label text-muted">Token</span>
            <div className="flex min-w-0 items-center gap-2">
              <code
                data-testid="sync-token"
                className="label min-w-0 flex-1 break-all rounded-sm border border-line bg-bg px-2 py-2 text-fg"
              >
                {token}
              </code>
              <CopyButton value={token} label="Kopiera token" />
            </div>
          </div>
          {appUrl ? (
            <div className="flex flex-col gap-1.5">
              <span className="label text-muted">Binderlabs adress</span>
              <div className="flex min-w-0 items-center gap-2">
                <code className="label min-w-0 flex-1 truncate rounded-sm border border-line bg-bg px-2 py-2 text-fg">
                  {appUrl}
                </code>
                <CopyButton value={appUrl} label="Kopiera adressen" />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label="Dator"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            hint="Vilken dator token är till, så att du vet vilken du ska återkalla."
            required
          />
          {error ? (
            <p role="alert" className="text-sm text-signal-fg">
              {error}
            </p>
          ) : null}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

function RevokeDialog({
  open,
  token,
  onClose,
}: {
  open: boolean;
  token: SyncTokenView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      if (!token) return;
      setError(null);
      const result = await revokeSyncToken({ id: token.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: "Token är återkallad", description: "Tillägget med den token slutar synka direkt.", tone: "ok" });
      onClose();
      router.refresh();
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      eyebrow="Återkalla token"
      title={token ? token.name : "Token"}
      description="Tillägget som använder den här token slutar synka direkt. Det går inte att ångra; skapa en ny token om du behöver."
      footer={
        <>
          <Button onClick={onClose}>Avbryt</Button>
          <Button variant="danger-confirm" loading={pending} onClick={submit}>
            Återkalla
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
