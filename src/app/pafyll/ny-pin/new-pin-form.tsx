"use client";

import { useActionState, useTransition } from "react";

import { Button } from "@/components/v2/button";

import { AuthInput } from "@/app/logga-in/auth-field";
import { FormError } from "@/app/logga-in/form-error";

import { staffSetPin, staffSkipPin, type PinState } from "../actions";

export function NewPinForm({ askCurrent }: { askCurrent: boolean }) {
  const [state, action, pending] = useActionState<PinState, FormData>(staffSetPin, {});
  const [skipping, start] = useTransition();
  return (
    <form action={action} className="flex flex-col gap-4">
      {askCurrent ? (
        <AuthInput
          label="Nuvarande PIN-kod"
          name="current"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
        />
      ) : null}
      <AuthInput
        label="Ny PIN-kod"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus={!askCurrent}
      />
      <AuthInput
        label="Samma PIN-kod igen"
        name="again"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]{6}"
        maxLength={6}
        required
      />
      <FormError message={state.error} />
      <Button type="submit" variant="act" size="lg" pending={pending} className="w-full">
        Spara
      </Button>
      {!askCurrent ? (
        <button
          type="button"
          className="mx-auto min-h-11 px-3 text-v2-sm text-v2-mute underline"
          disabled={skipping}
          onClick={() => start(() => staffSkipPin())}
        >
          Behåll koden jag fick
        </button>
      ) : null}
    </form>
  );
}
