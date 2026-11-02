import type { Metadata } from "next";

import { AuthFrame } from "../auth-frame";
import { ConfirmForm } from "./confirm-form";

export const metadata: Metadata = { title: "Bekräfta inloggning" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Landningssidan för inloggningslänken i mejlet
 * (`{{ .RedirectTo }}?token_hash=…&type=magiclink`, se docs/miljoer.md).
 * Länken förbrukas först när personen trycker på knappen (POST), så att
 * e-postprogram som förhandsgranskar länkar inte förbrukar den.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const tokenHash = first(params.token_hash);
  const type = first(params.type);
  return (
    <AuthFrame
      eyebrow={
        <>
          <span className="tnum text-fg">02</span>
          <span aria-hidden className="text-faint">
            /
          </span>
          <span>Inloggningslänk</span>
        </>
      }
      title="Bekräfta inloggningen."
      aside="Ett klick, sedan är du inne."
    >
      <ConfirmForm tokenHash={tokenHash} type={type} />
    </AuthFrame>
  );
}
