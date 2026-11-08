import { NextResponse } from "next/server";

import { liveBuildId } from "@/server/build-id";

// Svaret ska alltid vara det som körs nu: aldrig förrenderat eller sparat någonstans.
export const dynamic = "force-dynamic";

/**
 * GET /api/version: byggets id som servern kör, t.ex. {"buildId":"dpl_abc"}. Öppen utan
 * inloggning (src/server/auth/paths.ts) och utan hemligheter. Telefonen jämför det med
 * sidans bygge och visar "Ny version av appen finns" när de skiljer sig.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { buildId: await liveBuildId() },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    },
  );
}
