"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";

/**
 * Formulärfält i V2 (Polaris): etikett 13 px halvfet, vitt fält 36 px (44 px på telefon),
 * radie 8, kant #8A8A8A, hjälptext 13 px grå och fel i rött under fältet.
 *
 *   <Field label="Kortavgift" hint="Från din utbetalning" error={err}>
 *     {(p) => <Input {...p} name="fee" inputMode="decimal" suffix="%" />}
 *   </Field>
 *
 * Field ger id, aria-describedby och aria-invalid till fältet (render-prop), så att etikett och
 * fel alltid hör ihop. Input/Select/Textarea går också att använda utan Field (då med
 * aria-label). Klasserna .v2-input/.v2-select/.v2-textarea finns i src/styles/v2.css för egna fält.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  id: idProp,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
  className?: string;
  id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const msg = error || hint ? `${id}-msg` : undefined;
  return (
    <div className={cn("v2-field", className)}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": msg, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={msg} className="err">
          {error}
        </p>
      ) : hint ? (
        <p id={msg} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Textfält. `suffix` ("kr", "%") står inne i fältet till höger. */
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { suffix?: string }
>(function Input({ className, suffix, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      className={cn("v2-input", rest.type === "number" && "num", className)}
      {...rest}
    />
  );
  if (!suffix) return input;
  return (
    <span className="v2-input-wrap">
      {input}
      <span className="sfx" aria-hidden="true">
        {suffix}
      </span>
    </span>
  );
});

/** Native select (rätt beteende på telefon och med skärmläsare) med V2:s pil. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn("v2-select", className)} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn("v2-textarea", className)} {...rest} />;
});
