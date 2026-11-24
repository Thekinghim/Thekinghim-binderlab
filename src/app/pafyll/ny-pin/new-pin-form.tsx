"use client";

import { useActionState, useTransition } from "react";

import { Button } from "@/components/v2/button";

import { AuthInput } from "@/app/logga-in/auth-field";
import { FormError } from "@/app/logga-in/form-error";

import { staffSetPin, staffSkipPin, type PinState } from "../actions";

export function NewPinForm() {
  const [state, action, pending] = useActionState<PinState, FormData>(staffSetPin, {});
  const [skipping, start] = useTransition();
  return (
    <form action={action} className="flex flex-col gap-4">
      <AuthInput
        label="Ny PIN-kod"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
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
      <Button
        size="lg"
        variant="quiet"
        className="w-full"
        pending={skipping}
        onClick={() => start(() => staffSkipPin())}
      >
        Hoppa över
      </Button>
    </form>
  );
}
