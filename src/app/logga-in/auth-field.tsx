"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

import { Field, Input } from "@/components/v2/field";

/**
 * Ett V2-fält med etikett, hjälptext och fel (Field + Input) för sidorna utan inloggning.
 * Samma etiketter som förut, så att getByLabel("E-post") och liknande hittar fälten.
 */
export function AuthInput({
  label,
  hint,
  error,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => <Input {...rest} {...p} />}
    </Field>
  );
}
