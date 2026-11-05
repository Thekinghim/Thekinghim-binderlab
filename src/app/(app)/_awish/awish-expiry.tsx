/**
 * En rad när Awish-kontot går ut inom 30 dagar: "Awish-kontot går ut 18 apr. 2027 –
 * förläng hos Awish." Röd när högst 7 dagar är kvar. Bara ägare och admin (loadAwishExpiryFor
 * ger null för andra). Samma rad på Att göra, Drift och Datakällor.
 */

import Link from "next/link";

import { cn } from "@/lib/cn";
import type { AwishExpiryNotice } from "@/server/awish/expiry";

export function AwishExpiry({
  notice,
  link = true,
  className,
}: {
  notice: AwishExpiryNotice | null;
  /** Länk till Datakällor (inte på Datakällor själv). */
  link?: boolean;
  className?: string;
}) {
  if (!notice) return null;
  const urgent = notice.level === "now";
  return (
    <section
      aria-label="Awish-kontot"
      role={urgent ? "alert" : undefined}
      className={cn(
        "rise mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 max-md:mb-4 max-md:flex-nowrap max-md:px-3 max-md:py-2",
        urgent ? "border-signal-line bg-signal-soft" : "border-line bg-surface",
        className,
      )}
    >
      <p
        className={cn(
          "text-base max-md:min-w-0 max-md:text-sm",
          urgent ? "text-signal-fg" : "text-fg",
        )}
      >
        {`${notice.text}.`}
      </p>
      {link ? (
        <Link
          href="/datakallor"
          className="inline-flex min-h-11 shrink-0 items-center text-sm text-muted underline-offset-2 hover:underline md:min-h-0"
        >
          Datakällor
        </Link>
      ) : null}
    </section>
  );
}
