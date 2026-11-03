"use client";

import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";

import { confirmMagicLink } from "../actions";
import { LinkFailed, LinkPending, useLinkFragment } from "../link-landing";
import type { ConfirmState } from "../state";

/**
 * Tar emot inloggningslänken. Standardmallen lämnar sessionen i fragmentet
 * (fungerar i vilken webbläsare som helst); `token_hash` (egen mall) och
 * `code` (PKCE, äldre länkar) kommer i frågesträngen. Ett tryck på
 * "Logga in" loggar in; går det inte visas "Logga in med lösenord".
 */
export function ConfirmForm({
  tokenHash,
  code = "",
  type,
}: {
  tokenHash: string;
  code?: string;
  type: string;
}) {
  const [state, action, pending] = useActionState<ConfirmState, FormData>(confirmMagicLink, {});
  const fragment = useLinkFragment();
  const recovery = fragment?.kind === "tokens" && fragment.type === "recovery";

  // En länk för nytt lösenord som hamnat här: till rätt sida med samma session.
  useEffect(() => {
    if (recovery && fragment?.kind === "tokens") {
      const hash = new URLSearchParams({
        access_token: fragment.accessToken,
        refresh_token: fragment.refreshToken,
        type: "recovery",
      });
      window.location.replace(`/logga-in/nytt-losenord#${hash.toString()}`);
    }
  }, [recovery, fragment]);

  if (fragment === null || recovery) return <LinkPending />;
  const tokens = fragment.kind === "tokens" ? fragment : null;
  const usable = tokens !== null || tokenHash !== "" || code !== "";
  if (!usable || state.failed) return <LinkFailed />;

  return (
    <form action={action} className="flex flex-col gap-4">
      {tokens ? (
        <>
          <input type="hidden" name="access_token" value={tokens.accessToken} />
          <input type="hidden" name="refresh_token" value={tokens.refreshToken} />
        </>
      ) : code ? (
        <input type="hidden" name="code" value={code} />
      ) : (
        <>
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
        </>
      )}
      {tokens?.email ? <p className="meta wrap-anywhere text-muted">{tokens.email}</p> : null}
      <Button type="submit" variant="primary" loading={pending} className="h-12 w-full text-lg">
        Logga in
      </Button>
    </form>
  );
}
