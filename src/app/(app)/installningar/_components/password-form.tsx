"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { changePassword, sendOwnPasswordLink } from "@/server/actions/auth";

import { PASSWORD_MIN_LENGTH, passwordFormErrors, type PasswordFields } from "../_lib/model";

/**
 * Byte av eget lösenord. Alla roller. Med `canEmailLink` (Supabase) kan den som
 * saknar lösenord (loggar in med länk) få en länk för att välja ett.
 */
export function PasswordForm({ canEmailLink = false }: { canEmailLink?: boolean }) {
  const toast = useToast();
  const [sending, startSend] = useTransition();
  const sendLink = () =>
    startSend(async () => {
      const result = await sendOwnPasswordLink();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: "Kolla mejlen", description: "Länken gäller 1 timme.", tone: "ok" });
    });
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof PasswordFields, string>>>({});
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fields: PasswordFields = {
      current: String(form.get("current") ?? ""),
      next: String(form.get("next") ?? ""),
      confirm: String(form.get("confirm") ?? ""),
    };
    const found = passwordFormErrors(fields);
    setErrors(found);
    setError(undefined);
    if (Object.keys(found).length > 0) return;
    startTransition(async () => {
      const result = await changePassword(fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      formRef.current?.reset();
      toast({ title: "Lösenordet är bytt", tone: "ok" });
    });
  };

  const clear = (name: keyof PasswordFields) => () => {
    setErrors((prev) => ({ ...prev, [name]: undefined }));
    setError(undefined);
  };

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Byt lösenord"
    >
      <Input
        label="Nuvarande lösenord"
        name="current"
        type="password"
        autoComplete="current-password"
        error={errors.current}
        onChange={clear("current")}
      />
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <Input
          label="Nytt lösenord"
          name="next"
          type="password"
          autoComplete="new-password"
          error={errors.next}
          hint={`Minst ${PASSWORD_MIN_LENGTH} tecken.`}
          onChange={clear("next")}
        />
        <Input
          label="Upprepa nytt lösenord"
          name="confirm"
          type="password"
          autoComplete="new-password"
          error={errors.confirm}
          onChange={clear("confirm")}
        />
      </div>
      <FormError message={error} />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {canEmailLink ? (
          <Button type="button" variant="ghost" loading={sending} onClick={sendLink}>
            Inget lösenord? Få länk
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" variant="primary" loading={pending}>
          Byt lösenord
        </Button>
      </div>
    </form>
  );
}
