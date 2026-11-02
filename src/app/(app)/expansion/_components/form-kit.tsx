"use client";

/**
 * Formulär i dialog för Expansion, Enhetsekonomi och Effekt: fälten beskrivs som data,
 * värdena är text (tolkas på servern), felen visas vid fältet och som notis. Efter en
 * lyckad ändring räknas sidan om: server actions anropar revalidateAppData, och svaret
 * bär den nya sidan.
 */

import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import type { ActionResult } from "../_lib/action-result";

export type FieldSpec = {
  name: string;
  label: string;
  type?:
    "text" | "decimal" | "integer" | "date" | "month" | "select" | "textarea" | "email" | "tel";
  options?: Array<{ value: string; label: string }>;
  suffix?: string;
  hint?: string;
  required?: boolean;
  /** Visa fältet bara när villkoret gäller för de aktuella värdena. */
  when?: (values: Record<string, string>) => boolean;
  /** Bredd i formulärets rutnät (2 kolumner från sm). */
  span?: 1 | 2;
  placeholder?: string;
};

export type Action<T> = (raw: unknown) => Promise<ActionResult<T>>;

/**
 * Kör en server action med notis. `pending` gäller bara själva anropet: sidans omräkning
 * efter revalidateAppData sker i bakgrunden, så att nästa formulär kan skickas direkt.
 */
export function useActionRunner() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async <T,>(
    action: Action<T>,
    raw: unknown,
    opts: {
      success: string;
      onOk?: (data: T) => void;
      onError?: (r: { error: string; fieldErrors?: Record<string, string> }) => void;
    },
  ) => {
    setPending(true);
    try {
      const r = await action(raw);
      if (r.ok) {
        toast({ title: opts.success, tone: "ok" });
        opts.onOk?.(r.data);
      } else {
        toast({ title: "Det gick inte att spara", description: r.error, tone: "critical" });
        opts.onError?.(r);
      }
    } catch {
      toast({
        title: "Det gick inte att spara",
        description: "Servern svarade inte. Försök igen.",
        tone: "critical",
      });
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

const textareaCls =
  "min-h-24 w-full min-w-0 rounded-sm border border-line-control bg-bg px-3 py-2 text-base text-fg transition-[border-color] duration-fast ease-instrument placeholder:text-subtle enabled:hover:border-muted";

function TextArea({
  label,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="label text-muted">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        className={cn(textareaCls, error && "border-signal")}
        rows={4}
      />
      {error ? (
        <p id={`${id}-msg`} className="text-xs text-signal-fg">
          ! {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Dialog med formulär. `initial` är fältens text; `fixed` skickas med oförändrat (t.ex. id). */
export function FormModal<T>({
  open,
  onClose,
  title,
  eyebrow,
  description,
  fields,
  initial,
  fixed,
  action,
  success,
  submitLabel = "Spara",
  extraFooter,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  description?: string;
  fields: ReadonlyArray<FieldSpec>;
  initial: Record<string, string>;
  fixed?: Record<string, string | null>;
  action: Action<T>;
  success: string;
  submitLabel?: string;
  extraFooter?: ReactNode;
}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { pending, run } = useActionRunner();
  const formId = useId();

  // Nya startvärden när dialogen öppnas (eller öppnas för en annan rad). Justeras under
  // renderingen i stället för i en effekt, så att formuläret aldrig visar gamla värden.
  const initialKey = JSON.stringify(initial);
  const [shown, setShown] = useState<{ open: boolean; key: string }>({ open, key: initialKey });
  if (shown.open !== open || (open && shown.key !== initialKey)) {
    setShown({ open, key: initialKey });
    if (open) {
      setValues(initial);
      setErrors({});
      setFormError(null);
    }
  }

  const set = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));
  const visible = fields.filter((f) => !f.when || f.when(values));

  const submit = () => {
    const raw: Record<string, string | null> = { ...(fixed ?? {}) };
    for (const f of visible) raw[f.name] = values[f.name] ?? "";
    run(action, raw, {
      success,
      onOk: () => onClose(),
      onError: (r) => {
        setErrors(r.fieldErrors ?? {});
        setFormError(r.fieldErrors && Object.keys(r.fieldErrors).length > 0 ? null : r.error);
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      eyebrow={eyebrow}
      description={description}
      footer={
        <>
          {extraFooter}
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {formError ? (
          <p role="alert" className="text-sm text-signal-fg sm:col-span-2">
            ! {formError}
          </p>
        ) : null}
        {visible.map((f) => {
          const common = {
            label: f.required ? f.label : `${f.label} (valfritt)`,
            error: errors[f.name],
            hint: f.hint,
          };
          const span = f.span === 2 || f.type === "textarea" ? "sm:col-span-2" : undefined;
          if (f.type === "select") {
            return (
              <Select
                key={f.name}
                {...common}
                label={f.label}
                wrapperClassName={span}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                options={f.options ?? []}
              />
            );
          }
          if (f.type === "textarea") {
            return (
              <div key={f.name} className={span}>
                <TextArea
                  {...common}
                  value={values[f.name] ?? ""}
                  onChange={(v) => set(f.name, v)}
                />
              </div>
            );
          }
          const numeric = f.type === "decimal" || f.type === "integer";
          return (
            <Input
              key={f.name}
              {...common}
              wrapperClassName={span}
              type={
                f.type === "date"
                  ? "date"
                  : f.type === "month"
                    ? "month"
                    : f.type === "email"
                      ? "email"
                      : f.type === "tel"
                        ? "tel"
                        : "text"
              }
              inputMode={
                f.type === "decimal" ? "decimal" : f.type === "integer" ? "numeric" : undefined
              }
              className={numeric ? "tnum text-right" : undefined}
              suffix={f.suffix}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
              autoComplete="off"
            />
          );
        })}
      </form>
    </Modal>
  );
}

/** Knapp som tar bort en rad efter bekräftelse i dialog. */
export function DeleteButton({
  action,
  id,
  what,
  success,
}: {
  action: Action<undefined>;
  id: string;
  what: string;
  success: string;
}) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useActionRunner();
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Ta bort
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={`Ta bort ${what}?`}
        description="Det går inte att ångra. Ändringen sparas i ändringsloggen."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button
              type="button"
              variant="danger-confirm"
              loading={pending}
              onClick={() => run(action, { id }, { success, onOk: () => setOpen(false) })}
            >
              Ta bort
            </Button>
          </>
        }
      />
    </>
  );
}
