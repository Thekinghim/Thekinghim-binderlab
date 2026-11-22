"use client";

import { useId, useState, type ReactNode } from "react";

import { Button, ButtonLink } from "@/components/v2/button";
import { useT } from "@/i18n/client";
import { sv, type Messages } from "@/i18n/sv";
import { cn } from "@/lib/cn";

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
   * ersätter den standardprefixet ("TOMT" → "0 AV 1 240").
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
  /** Prickens ton (v2.css .v2-dot): bara fel som kräver åtgärd får signalfärg. */
  dot: "critical" | "warning" | "off";
  /** Koden läggs efter prefixet i stället för att ersätta det. */
  appendCode: boolean;
  role: "status" | "alert";
};

const kinds: Record<StateKind, KindSpec> = {
  empty: { prefix: "Tomt", dot: "off", appendCode: false, role: "status" },
  "no-results": { prefix: "0 träffar", dot: "off", appendCode: false, role: "status" },
  error: { prefix: "Fel", dot: "critical", appendCode: true, role: "alert" },
  "loading-failed": { prefix: "Ej laddad", dot: "critical", appendCode: true, role: "alert" },
  offline: { prefix: "Ur drift", dot: "off", appendCode: true, role: "status" },
  denied: { prefix: "Saknar behörighet", dot: "warning", appendCode: true, role: "status" },
  "not-configured": { prefix: "Av", dot: "off", appendCode: false, role: "status" },
};

/** Prefixet som det skrivs ut, t.ex. "FEL 503" eller "TOMT" (visas i V2 som "Fel 503", "Tomt"). */
export function statePrefix(
  kind: StateKind,
  code?: string,
  prefixes: Messages["state"]["prefix"] = sv.state.prefix,
): string {
  const spec = kinds[kind];
  const prefix = prefixes[kind] ?? spec.prefix;
  if (!code) return prefix.toUpperCase();
  return (spec.appendCode ? `${prefix} ${code}` : code).toUpperCase();
}

function isActionObject(
  a: StateAction,
): a is { label: string; onClick?: () => void; href?: string; loading?: boolean } {
  return typeof a === "object" && a !== null && !Array.isArray(a) && "label" in a;
}

/** En åtgärd som V2-knapp: huvudåtgärden mörk (act), den andra vit. 44 px på telefon. */
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
  const variant = emphasis === "primary" && !compact ? "act" : "default";
  const size = compact ? "sm" : "md";
  if (action.href) {
    return (
      <ButtonLink href={action.href} variant={variant} size={size} touch>
        {action.label}
      </ButtonLink>
    );
  }
  return (
    <Button variant={variant} size={size} touch onClick={action.onClick} pending={action.loading}>
      {action.label}
    </Button>
  );
}

/**
 * Prick + prefix som en liten grå etikett (V2: 12 px halvfet, gemener, ingen spärrning).
 * Texten står i versaler i DOM (statePrefix) och visas som "Tomt", "Ej laddad".
 */
function Prefix({ kind, code }: { kind: StateKind; code?: string }) {
  const t = useT();
  const spec = kinds[kind];
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-v2-xs font-[550] text-v2-mute">
      <span className={cn("v2-dot", spec.dot)} aria-hidden="true" />
      <span className="tnum lowercase first-letter:uppercase">
        {statePrefix(kind, code, t.state.prefix)}
      </span>
    </span>
  );
}

type CopyState = "idle" | "copied" | "failed";

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
  const t = useT();
  const copyLabels: Record<CopyState, string> = {
    idle: t.state.copy,
    copied: t.state.copied,
    failed: t.state.copyFailed,
  };
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
      <div className="relative w-full max-w-xl rounded-v2 border border-v2-line bg-v2-hover text-v2-xs select-text">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 py-2.5 pr-24 pl-3">
          {items.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-v2-mute">{d.label}</dt>
              <dd className="tnum [overflow-wrap:anywhere] text-v2-ink">{d.value}</dd>
            </div>
          ))}
        </dl>
        <Button size="sm" variant="quiet" onClick={copy} className="absolute top-1 right-1">
          {copyState === "copied" ? copyLabels.copied : copyLabels.idle}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "idle" ? "" : copyLabels[copyState]}
      </span>
      {copyState === "failed" ? (
        <p className="mt-1.5 text-v2-xs text-v2-mute">
          Kunde inte kopiera. Markera texten och kopiera manuellt.
        </p>
      ) : null}
    </div>
  );
}

/** Pil för "Visa detaljer": pekar ner, vänds upp när detaljerna är utfällda. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={cn("transition-transform duration-150", open && "rotate-180")}
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Tomt läge eller felläge i V2 (Polaris, Google Sans, bara ljust): en prick och en liten grå
 * etikett ("Tomt", "Ej laddad"), en mening om vad som saknas eller gick fel, en grå rad med
 * nästa steg och V2-knappar. Signalfärg bara på pricken, och bara för fel som kräver åtgärd.
 *
 * Används också utanför appens skal (rapportsidorna, felsidan, ConfigMissing). Markören
 * data-ui="v2" (ett tomt, dolt element) ger då sidan V2:s färger och typsnitt via
 * :root:has([data-ui="v2"]) i src/styles/v2.css, samma som RouteNotFound. Inne i skalet gör
 * den ingenting.
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
  const t = useT();
  const [open, setOpen] = useState(diagnosticsOpen);
  const diagId = useId();
  const spec = kinds[kind];
  const hasDiag = diagnostics !== undefined && diagnostics.length > 0;
  const marker = <span data-ui="v2" hidden />;

  const toggle = hasDiag ? (
    <Button
      size={compact ? "sm" : "md"}
      variant="quiet"
      touch
      aria-expanded={open}
      aria-controls={diagId}
      onClick={() => setOpen((v) => !v)}
    >
      {open ? t.state.hideDetails : t.state.showDetails}
      <Chevron open={open} />
    </Button>
  ) : null;

  if (compact) {
    // En radmall för alla lägen: prefixet på första raden, meningen under och åtgärderna
    // högerställda på meningens baslinje.
    return (
      <div role={spec.role} className={cn("v2-enter flex flex-col gap-2 px-3.5 py-3", className)}>
        {marker}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-1">
          <Prefix kind={kind} code={code} />
          <p className="col-start-1 min-w-0 text-v2-md text-v2-ink">
            {message}
            {detail ? <span className="text-v2-mute"> {detail}</span> : null}
          </p>
          {action || secondaryAction || toggle ? (
            <div className="col-start-2 row-span-2 row-start-1 flex flex-wrap items-center justify-end gap-1.5 self-end">
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
      className={cn("v2-enter flex flex-col items-start px-[18px] pt-6 pb-5", className)}
    >
      {marker}
      <Prefix kind={kind} code={code} />
      <p className="mt-2 max-w-xl text-v2-md font-[550] text-pretty text-v2-ink">{message}</p>
      {detail ? (
        <p className="mt-1 max-w-xl text-v2-md text-pretty text-v2-mute">{detail}</p>
      ) : null}
      {action || secondaryAction || toggle ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {action ? <ActionControl action={action} emphasis="primary" compact={false} /> : null}
          {secondaryAction ? (
            <ActionControl action={secondaryAction} emphasis="secondary" compact={false} />
          ) : null}
          {toggle}
        </div>
      ) : null}
      {hasDiag ? (
        <Diagnostics id={diagId} items={diagnostics} open={open} className="mt-3" />
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
      <td colSpan={colSpan} className={cn("border-b border-v2-line p-0", className)}>
        <StateMessage compact={compact} {...props} />
      </td>
    </tr>
  );
}
