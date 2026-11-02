"use client";

import { usePathname } from "next/navigation";

import { StateMessage } from "@/components/ui/state-message";

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
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <StateMessage
        kind="empty"
        code="Ingen automat"
        message={code ? `Automaten ${code} finns inte.` : "Automaten finns inte."}
        detail="Länken kan vara fel, eller så hör automaten till en annan organisation."
        action={{ label: "Alla automater", href: "/automater" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
