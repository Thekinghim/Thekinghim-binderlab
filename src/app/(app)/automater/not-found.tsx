"use client";

import { usePathname } from "next/navigation";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";

/** Koden ur sökvägen (/automater/bl-999 → BL-999), eller null för ett id eller tom väg. */
function codeOf(pathname: string | null): string | null {
  const slug = pathname?.split("/").filter(Boolean)[1];
  if (!slug) return null;
  const code = decodeURIComponent(slug).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(code)) return null;
  return code.length > 0 && code.length <= 32 ? code.toUpperCase() : null;
}

/** Okänd automat (notFound() i sidan): kod som inte finns eller id från en annan organisation. */
export default function MachineNotFound() {
  const code = codeOf(usePathname());
  const message = code ? `Automaten ${code} finns inte.` : "Automaten finns inte.";
  return (
    <V2Page title="Automaten finns inte">
      <Card>
        <Empty
          title={message}
          action={
            <ButtonLink href="/automater" touch>
              Alla automater
            </ButtonLink>
          }
        >
          Länken kan vara fel, eller så hör automaten till en annan organisation.
        </Empty>
      </Card>
    </V2Page>
  );
}
