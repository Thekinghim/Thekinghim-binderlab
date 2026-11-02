"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { confirmMagicLink } from "../actions";
import { FormError } from "../form-error";
import type { ConfirmState } from "../state";

export function ConfirmForm({ tokenHash, type }: { tokenHash: string; type: string }) {
  const [state, action, pending] = useActionState<ConfirmState, FormData>(confirmMagicLink, {});
  const missing = tokenHash === "";
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <FormError
        message={missing ? "Länken är ofullständig. Kopiera hela länken från mejlet." : state.error}
      />
      {missing || state.error ? (
        <Link
          href="/logga-in"
          className="inline-flex h-9 items-center justify-center rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg hover:border-line-control hover:bg-hover"
        >
          Begär en ny länk
        </Link>
      ) : (
        <Button type="submit" variant="primary" loading={pending} className="w-full">
          Logga in
        </Button>
      )}
    </form>
  );
}
