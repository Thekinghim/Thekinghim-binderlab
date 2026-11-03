import type { Metadata } from "next";

import { AuthFrame } from "../auth-frame";
import { ConfirmForm } from "./confirm-form";

export const metadata: Metadata = { title: "Logga in" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Landningssidan för inloggningslänken i mejlet. Med Supabases standardmall
 * kommer sessionen i fragmentet (`#access_token=…`, läses i webbläsaren); med en
 * egen mall `?token_hash=…`; äldre PKCE-länkar `?code=…`. Inloggningen sker
 * först när personen trycker på knappen (POST).
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return (
    <AuthFrame eyebrow={<span>Inloggning</span>} title="Logga in.">
      <ConfirmForm
        tokenHash={first(params.token_hash)}
        code={first(params.code)}
        type={first(params.type)}
      />
    </AuthFrame>
  );
}
