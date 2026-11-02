"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { StatusGlyph, type Status } from "./status-tag";

export type StateKind =
  "empty" | "no-results" | "error" | "offline" | "denied" | "loading-failed" | "not-configured";

/** En åtgärd som objekt (renderas som knapp eller länk) eller valfri nod. */
export type StateAction =
  { label: string; onClick?: () => void; href?: string; loading?: boolean } | ReactNode;

export type StateDiagnostic = { label: string; value: string };

export type StateMessageProps = {
  kind: StateKind;
  /**
   * Kod till prefixet. För fel, offline och behörighet läggs den efter
   * ordet ("FEL 503"), så att ordet alltid står kvar. För tomma lägen
   * ersätter den standardprefixet ("0 RADER" → "0 AV 1 240").
   */
  code?: string;
  /** En mening: vad som saknas eller gick fel, var och när. */
  message: string;
  /** Sakuppgift som hjälper nästa steg, t.ex. "Senaste lyckade synk 14:32." */
  detail?: ReactNode;
  /** Den tydliga nästa åtgärden. */
  action?: StateAction;
  secondaryAction?: StateAction;
  /** Tekniska uppgifter (request-id, tid, tjänst) bakom "Visa detaljer". Ingen stacktrace. */
  diagnostics?: ReadonlyArray<StateDiagnostic>;
  /** Visa diagnostiken utfälld från start. */
  diagnosticsOpen?: boolean;
  /** Inline-rad för tabell eller panel i stället för block. */
  compact?: boolean;
  className?: string;
};

type KindSpec = {
  prefix: string;
  glyph: Status;
  /** Koden läggs efter prefixet i stället för att ersätta det. */
  appendCode: boolean;
  role: "status" | "alert";
};

const kinds: Record<StateKind, KindSpec> = {
  empty: { prefix: "0 rader", glyph: "neutral", appendCode: false, role: "status" },
  "no-results": { prefix: "0 träffar", glyph: "neutral", appendCode: false, role: "status" },
  error: { prefix: "Fel", glyph: "critical", appendCode: true, role: "alert" },
  "loading-failed": { prefix: "Ej laddad", glyph: "critical", appendCode: true, role: "alert" },
  offline: { prefix: "Ur drift", glyph: "offline", appendCode: true, role: "status" },
  denied: { prefix: "Saknar behörighet", glyph: "warning", appendCode: true, role: "status" },
  "not-configured": {
    prefix: "Ej konfigurerad",
    glyph: "offline",
    appendCode: false,
    role: "status",
  },
};

/** Prefixet som det skrivs ut, t.ex. "FEL 503" eller "0 RADER". */
export function statePrefix(kind: StateKind, code?: string): string {
  const spec = kinds[kind];
  if (!code) return spec.prefix.toUpperCase();
  return (spec.appendCode ? `${spec.prefix} ${code}` : code).toUpperCase();
}

/** Signalfärg reserveras för fel som kräver åtgärd. */
function needsAction(kind: StateKind) {
  return kind === "error" || kind === "loading-failed";
}

function isActionObject(
  a: StateAction,
): a is { label: string; onClick?: () => void; href?: string; loading?: boolean } {
  return typeof a === "object" && a !== null && !Array.isArray(a) && "label" in a;
}

function ActionControl({
  action,
  emphasis,
  compact,
}: {
  action: StateAction;
  emphasis: "primary" | "secondary";
  compact: boolean;
}) {
  if (!isActionObject(action)) return <>{action}</>;
  const label = (
    <>
      {action.label}
      {emphasis === "primary" ? (
        <span aria-hidden className="ml-1.5 font-mono">
          →
        </span>
      ) : null}
    </>
  );

  if (compact) {
    const cls = cn(
      "inline-flex h-7 items-center rounded-xs px-1.5 font-mono text-sm whitespace-nowrap underline-offset-4 transition-colors duration-[120ms] ease-instrument",
      emphasis === "primary"
        ? "text-fg underline decoration-line-control hover:decoration-fg"
        : "text-muted hover:text-fg",
    );
    return action.href ? (
      <a href={action.href} className={cls}>
        {label}
      </a>
    ) : (
      <button
        type="button"
        onClick={action.onClick}
        disabled={action.loading}
        aria-busy={action.loading || undefined}
        className={cn(cls, "disabled:opacity-40")}
      >
        {label}
      </button>
    );
  }

  if (action.href) {
    return (
      <a
        href={action.href}
        className={cn(
          "inline-flex h-9 items-center rounded-sm border px-3.5 text-base font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-[120ms] ease-instrument",
          emphasis === "primary"
            ? "border-inverse bg-inverse text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover"
            : "border-transparent text-muted hover:bg-hover hover:text-fg",
        )}
      >
        {label}
      </a>
    );
  }
  return (
    <Button
      variant={emphasis === "primary" ? "primary" : "ghost"}
      onClick={action.onClick}
      loading={action.loading}
    >
      {label}
    </Button>
  );
}

/** Glyf + versalt prefix. Glyfen är den enda delen som får signalfärg. */
function Prefix({ kind, code }: { kind: StateKind; code?: string }) {
  const spec = kinds[kind];
  return (
    <span className="label inline-flex shrink-0 items-center gap-2 text-fg">
      <span className={cn("inline-flex", needsAction(kind) ? "" : "text-muted")}>
        <StatusGlyph status={spec.glyph} />
      </span>
      <span className="tnum">{statePrefix(kind, code)}</span>
    </span>
  );
}

type CopyState = "idle" | "copied" | "failed";

const copyLabels: Record<CopyState, string> = {
  idle: "Kopiera",
  copied: "Kopierat",
  failed: "Kunde inte kopiera",
};

function Diagnostics({
  id,
  items,
  open,
  className,
}: {
  id: string;
  items: ReadonlyArray<StateDiagnostic>;
  open: boolean;
  className?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const text = items.map((d) => `${d.label}: ${d.value}`).join("\n");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard saknas");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      // Återkoppling i stället för tyst fel; texten går att markera manuellt.
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 3200);
    }
  };
  return (
    <div id={id} hidden={!open} className={cn("w-full", className)}>
      <div className="relative w-full max-w-xl rounded-sm border border-line bg-bg font-mono text-xs select-text">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 pt-2.5 pr-20 pb-2.5">
          {items.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-subtle">{d.label}</dt>
              <dd className="tnum [overflow-wrap:anywhere] text-fg">{d.value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          onClick={copy}
          className="absolute top-1.5 right-1.5 inline-flex h-6 items-center rounded-xs px-1.5 text-muted transition-colors duration-[120ms] ease-instrument hover:bg-hover hover:text-fg"
        >
          {copyState === "copied" ? copyLabels.copied : copyLabels.idle}
        </button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "idle" ? "" : copyLabels[copyState]}
      </span>
      {copyState === "failed" ? (
        <p className="mt-1.5 font-mono text-xs text-muted">
          Kunde inte kopiera. Markera texten och kopiera manuellt.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Tomt läge eller felläge utan illustration: en rad i monospace med
 * glyf och prefix, en mening om vad som saknas eller gick fel, och en
 * tydlig nästa åtgärd. Status bärs av prefixordet och glyfens form;
 * signalfärg används bara på glyfen, och bara för fel som kräver åtgärd.
 */
export function StateMessage({
  kind,
  code,
  message,
  detail,
  action,
  secondaryAction,
  diagnostics,
  diagnosticsOpen = false,
  compact = false,
  className,
}: StateMessageProps) {
  const [open, setOpen] = useState(diagnosticsOpen);
  const diagId = useId();
  const spec = kinds[kind];
  const hasDiag = diagnostics !== undefined && diagnostics.length > 0;

  const toggle = hasDiag ? (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={diagId}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "inline-flex items-center gap-1 rounded-xs font-mono text-muted transition-colors duration-[120ms] ease-instrument hover:text-fg",
        compact ? "h-7 px-1.5 text-sm" : "h-9 px-2 text-sm",
      )}
    >
      <span aria-hidden className="inline-block w-2.5 text-center">
        {open ? "−" : "+"}
      </span>
      {open ? "Dölj detaljer" : "Visa detaljer"}
    </button>
  ) : null;

  if (compact) {
    return (
      <div role={spec.role} className={cn("flex flex-col gap-2 px-3 py-2.5", className)}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Prefix kind={kind} code={code} />
          <p className="min-w-0 flex-1 basis-56 font-mono text-sm text-fg">
            {message}
            {detail ? <span className="text-subtle"> {detail}</span> : null}
          </p>
          {action || secondaryAction || toggle ? (
            <div className="-mr-1.5 ml-auto flex flex-wrap items-center justify-end gap-x-1">
              {action ? <ActionControl action={action} emphasis="primary" compact /> : null}
              {secondaryAction ? (
                <ActionControl action={secondaryAction} emphasis="secondary" compact />
              ) : null}
              {toggle}
            </div>
          ) : null}
        </div>
        {hasDiag ? <Diagnostics id={diagId} items={diagnostics} open={open} /> : null}
      </div>
    );
  }

  return (
    <div
      role={spec.role}
      className={cn("flex flex-col items-start px-5 pt-14 pb-6 md:px-6 md:pt-20", className)}
    >
      <Prefix kind={kind} code={code} />
      <p className="mt-3 max-w-xl font-mono text-md text-pretty text-fg">{message}</p>
      {detail ? <p className="mt-1.5 max-w-xl text-base text-muted">{detail}</p> : null}
      {action || secondaryAction || toggle ? (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {action ? <ActionControl action={action} emphasis="primary" compact={false} /> : null}
          {secondaryAction ? (
            <ActionControl action={secondaryAction} emphasis="secondary" compact={false} />
          ) : null}
          {toggle}
        </div>
      ) : null}
      {hasDiag ? (
        <Diagnostics id={diagId} items={diagnostics} open={open} className="mt-4" />
      ) : null}
    </div>
  );
}

/** Läget som en full-bredd-rad i en tabells tbody. */
export function StateRow({
  colSpan,
  className,
  compact = true,
  ...props
}: StateMessageProps & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("border-b border-line p-0", className)}>
        <StateMessage compact={compact} {...props} />
      </td>
    </tr>
  );
}
