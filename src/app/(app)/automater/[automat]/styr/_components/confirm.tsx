"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/v2/button";
import { Input } from "@/components/v2/field";
import { Notice } from "@/components/v2/notice";
import { Sheet, SheetClose } from "@/components/v2/sheet";
import { cn } from "@/lib/cn";

/** Det förhandsvisningen ger (samma form som ControlPreview på servern). */
export interface PreviewView {
  lines: string[];
  warnings: string[];
  blocking: string | null;
  confirm: string | null;
  /** Texten som måste skrivas (automatens kod), eller null. */
  typed: string | null;
}

/** Kan man trycka på bekräftaknappen? Allt som rutan kräver måste vara uppfyllt. */
export function canConfirm(a: {
  preview: PreviewView | null;
  checked: boolean;
  typed: string;
  extraValid?: boolean;
}): boolean {
  const p = a.preview;
  if (!p || p.blocking) return false;
  if (p.confirm && !a.checked) return false;
  if (p.typed && a.typed.trim().replace(/\s+/g, "").toUpperCase() !== p.typed.toUpperCase())
    return false;
  return a.extraValid !== false;
}

/**
 * Innehållet i bekräftelserutan: raderna, varningarna, hindret, frågan att kryssa i och
 * fältet där automatens kod skrivs. Ritas utan ark så att det går att testa.
 */
export function ConfirmBody({
  preview,
  loading,
  error,
  checked,
  onChecked,
  typed,
  onTyped,
  typedVerb,
  children,
}: {
  preview: PreviewView | null;
  loading: boolean;
  error: string | null;
  checked: boolean;
  onChecked: (v: boolean) => void;
  typed: string;
  onTyped: (v: string) => void;
  /** "stänga av", "mata ut" … */
  typedVerb?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {loading ? <p className="text-v2-sm text-v2-mute">Läser från Awish…</p> : null}
      {preview ? (
        <ul className="flex flex-col gap-1 text-v2-sm text-v2-ink" aria-label="Det här skickas">
          {preview.lines.map((l) => (
            <li key={l} className="tnum">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {preview?.warnings.length ? (
        <Notice tone="warning">
          {preview.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Notice>
      ) : null}
      {preview?.blocking ? <Notice tone="critical" title={preview.blocking} /> : null}
      {error ? <Notice tone="critical" title={error} live /> : null}
      {children}
      {preview?.confirm && !preview.blocking ? (
        <label className="flex items-start gap-2 text-v2-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={checked}
            onChange={(e) => onChecked(e.target.checked)}
          />
          <span>{preview.confirm}</span>
        </label>
      ) : null}
      {preview?.typed && !preview.blocking ? (
        <div className="v2-field">
          <label htmlFor="styr-typed">
            Skriv {preview.typed} för att {typedVerb ?? "bekräfta"}.
          </label>
          <Input
            id="styr-typed"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ark med förhandsvisning och bekräftelse. Knappen är spärrad tills allt som krävs är gjort
 * (kryss, skriven kod, egna fält). `danger` gör knappen röd.
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  preview,
  loading,
  error,
  confirmLabel,
  danger = false,
  pending,
  typedVerb,
  extraValid,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  preview: PreviewView | null;
  loading: boolean;
  error: string | null;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  typedVerb?: string;
  extraValid?: boolean;
  onConfirm: (a: { confirmed: boolean; typed: string }) => void;
  children?: ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const ready = canConfirm({ preview, checked, typed, extraValid });
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        if (!o) {
          setChecked(false);
          setTyped("");
        }
        onOpenChange(o);
      }}
      dismissible={!pending}
      title={title}
      description={description}
      footer={
        <>
          <SheetClose asChild>
            <Button touch disabled={pending}>
              Avbryt
            </Button>
          </SheetClose>
          <Button
            touch
            variant="act"
            className={cn(danger && "styr-danger")}
            disabled={!ready || loading}
            pending={pending}
            onClick={() => onConfirm({ confirmed: checked, typed })}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <ConfirmBody
        preview={preview}
        loading={loading}
        error={error}
        checked={checked}
        onChecked={setChecked}
        typed={typed}
        onTyped={setTyped}
        typedVerb={typedVerb}
      >
        {children}
      </ConfirmBody>
    </Sheet>
  );
}
