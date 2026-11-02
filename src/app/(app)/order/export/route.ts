/**
 * GET /order/export?…  Orderlistan som CSV: exakt det listan visar (period, butik,
 * automat, titel, sökning och sortering ur samma query), alla rader och inte bara de
 * som hunnit laddas. Bara ägare, admin och läsare.
 *
 * Svaret strömmas ut i satser (EXPORT_BATCH rader) ur en databasmarkör, så att hela
 * filen aldrig ligger i minnet. Nästa sats hämtas först när den förra är skickad.
 */

import type { NextRequest } from "next/server";

import { ECONOMY_ROLES, requireContextRole } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import { orderCsvColumns, orderCsvFileName, orderCsvPart } from "../_lib/csv";
import { EXPORT_LIMIT, streamOrderExportFor } from "../_lib/service";
import { currentViewer, listArgsFrom } from "../_lib/session";
import type { OrderRefs } from "../_lib/types";

export const dynamic = "force-dynamic";

const TEXT = { "content-type": "text/plain; charset=utf-8" };

class ExportCancelled extends Error {}

export async function GET(request: NextRequest): Promise<Response> {
  let ctx: Awaited<ReturnType<typeof requireContextRole>>;
  try {
    ctx = await requireContextRole(ECONOMY_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) return forbidden();
    throw error;
  }
  const { args } = await listArgsFrom(request.nextUrl.searchParams);
  const viewer = await currentViewer();
  const encoder = new TextEncoder();

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let wake: (() => void) | null = null;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        wake?.();
        wake = null;
      },
      cancel() {
        cancelled = true;
        wake?.();
        wake = null;
      },
    },
    { highWaterMark: 2 },
  );

  // Exporten startar direkt; svaret skickas när antalet är känt (413 om det är för många).
  let resolveStart!: (info: { count: number; refs: OrderRefs }) => void;
  const started = new Promise<{ count: number; refs: OrderRefs }>((r) => (resolveStart = r));
  let columns: ReturnType<typeof orderCsvColumns> | null = null;
  let first = true;

  const done = streamOrderExportFor(viewer, args, {
    begin(info) {
      resolveStart(info);
      if (info.count > EXPORT_LIMIT) return false;
      columns = orderCsvColumns(info.refs, ctx.timeZone);
      return true;
    },
    async batch(rows) {
      if (cancelled) throw new ExportCancelled();
      controller.enqueue(encoder.encode(orderCsvPart(rows, columns ?? [], first)));
      first = false;
      // Mottryck: vänta tills mottagaren läst ikapp innan nästa sats hämtas.
      while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
        await new Promise<void>((r) => (wake = r));
      }
      if (cancelled) throw new ExportCancelled();
    },
  });

  let info: { count: number; refs: OrderRefs } | null;
  try {
    info = await Promise.race([started, done.then(() => null)]);
  } catch (error) {
    if (error instanceof AuthorizationError) return forbidden();
    throw error;
  }
  if (info === null) {
    // Laddaren slutade utan att räkna (ska inte hända); skicka ett tomt svar.
    return new Response("Exporten misslyckades.", { status: 500, headers: TEXT });
  }
  if (info.count > EXPORT_LIMIT) {
    await done;
    return new Response(
      "Exporten rymmer högst 500 000 order. Välj en kortare period eller ett filter.",
      { status: 413, headers: TEXT },
    );
  }

  done.then(
    () => {
      if (cancelled) return;
      // Inga rader: bara BOM och rubrikrad.
      if (first) controller.enqueue(encoder.encode(orderCsvPart([], columns ?? [], true)));
      controller.close();
    },
    (error: unknown) => {
      if (error instanceof ExportCancelled || cancelled) return;
      console.error("[order] exporten avbröts", error);
      controller.error(error);
    },
  );

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${orderCsvFileName(args.period)}"`,
      "cache-control": "private, no-store",
    },
  });
}

function forbidden(): Response {
  return new Response("Du har inte behörighet att exportera order.", {
    status: 403,
    headers: TEXT,
  });
}
