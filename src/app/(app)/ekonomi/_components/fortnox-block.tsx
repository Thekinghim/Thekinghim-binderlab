/**
 * Ekonomi → Bokföring: raden om Fortnox ("Fortnox: allt bokfört t.o.m. i går.") och listan
 * över det som är skickat, med Fortnox verifikatnummer. Bara för ägare och admin utan Enkel
 * vy: för alla andra ritas ingenting (loadFortnoxFor svarar null).
 */

import Link from "next/link";

import { StatusGlyph, type Status } from "@/components/ui/status-tag";
import type { Viewer } from "@/server/data/core/loaders";
import { isDemoFor } from "@/server/demo/guard";
import { loadFortnoxFor } from "@/server/fortnox/service";

import { ReverseButton } from "../../datakallor/fortnox/_components/fortnox-panel";
import { VoucherList } from "../../datakallor/fortnox/_components/voucher-list";
import { heldVouchers, nextVouchers, outboxVouchers } from "../../datakallor/fortnox/_lib/view";

const GLYPH: Record<"ok" | "info" | "warn", Status> = {
  ok: "ok",
  info: "neutral",
  warn: "critical",
};

const LINK =
  "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg max-md:inline-flex max-md:min-h-11 max-md:items-center";

export async function FortnoxBlock({ viewer }: { viewer: Viewer }) {
  if (await isDemoFor(viewer.user, viewer.organization.id)) return null;
  const view = await loadFortnoxFor(viewer);
  if (!view) return null;
  const c = view.connection;
  const next = nextVouchers(view);
  const held = heldVouchers(view);
  const outbox = outboxVouchers(view, (id) => <ReverseButton id={id} />);
  const sent = view.outbox.filter((r) => r.state === "sent").length;
  return (
    <section
      id="fortnox"
      aria-label="Fortnox"
      data-fortnox-tone={view.line.tone}
      className="mb-8 flex scroll-mt-28 flex-col gap-3 rounded-md border border-line bg-surface p-4 md:p-5"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <span className="mt-1.5 shrink-0">
          <StatusGlyph status={GLYPH[view.line.tone]} />
        </span>
        <span data-fortnox-line className="min-w-0 break-words">
          {view.line.text}
        </span>
      </p>
      <p className="text-sm text-muted">
        <Link href="/datakallor/fortnox" className={LINK}>
          {c ? "Inställningar för Fortnox →" : "Koppla Fortnox →"}
        </Link>
      </p>
      {c?.live ? (
        <p className="text-sm text-muted">
          Fortnox bokför själv. Importera inte SIE-filen för samma månader, då blir det dubbelt.
        </p>
      ) : null}
      {c && (next.length > 0 || held.length > 0) ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">
            {c.live ? "Skickas i natt" : "Skulle skickas"} ({next.length})
            {held.length > 0 ? ` · väntar (${held.length})` : ""}
          </summary>
          <div className="mt-2 flex flex-col gap-4">
            <VoucherList label="Verifikat som skickas härnäst" vouchers={next} empty="Inget." />
            {held.length > 0 ? (
              <VoucherList label="Verifikat som väntar" vouchers={held} empty="" />
            ) : null}
          </div>
        </details>
      ) : null}
      {c && view.outbox.length > 0 ? (
        <details open={view.changed.length > 0 || view.line.tone === "warn"}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">
            Skickat till Fortnox ({sent})
          </summary>
          <div className="mt-2">
            <VoucherList
              label="Verifikat i Fortnox"
              vouchers={outbox}
              empty="Inget är skickat än."
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}
