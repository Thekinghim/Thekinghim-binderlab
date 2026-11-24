"use client";

import { useActionState } from "react";

import { Button } from "@/components/v2/button";

import { AuthInput } from "../auth-field";
import { FormError } from "../form-error";

import { signInWithPhone, type PhoneLoginState } from "./actions";

/** Mobilnummer och PIN-kod. Stora fält och knapp (telefon först). */
export function PhoneLoginForm({ notice, qrName }: { notice?: string; qrName?: string }) {
  const [state, action, pending] = useActionState<PhoneLoginState, FormData>(signInWithPhone, {});
  if (qrName) {
    return (
      <form action={action} className="fade-in flex flex-col gap-4">
        <input type="hidden" name="via" value="qr" />
        <p className="text-v2-md">
          Hej <b>{qrName}</b>! Skriv din PIN-kod.
        </p>
        <AuthInput
          label="PIN-kod"
          hint="6 siffror"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
        />
        <FormError message={state.error ?? notice} />
        <Button type="submit" variant="act" size="lg" pending={pending} className="w-full">
          Logga in
        </Button>
      </form>
    );
  }
  return (
    <form action={action} className="fade-in flex flex-col gap-4">
      <AuthInput
        label="Mobilnummer"
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="070-123 45 67"
        defaultValue={state.phone}
        required
        autoFocus
      />
      <AuthInput
        label="PIN-kod"
        hint="6 siffror"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="current-password"
        pattern="[0-9]{6}"
        maxLength={6}
        required
      />
      <FormError message={state.error ?? notice} />
      <Button type="submit" variant="act" size="lg" pending={pending} className="w-full">
        Logga in
      </Button>
    </form>
  );
}
