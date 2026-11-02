/**
 * POST /assistent/fraga: ställ en fråga till assistenten. Svaret strömmas som NDJSON
 * (en händelse per rad, se src/server/assistant/protocol.ts).
 *
 * Kräver inloggning och medlemskap i den aktiva organisationen. Rollen läses ur
 * databasen i askAssistant och styr vilka verktyg modellen får; verktygen läser som
 * användaren med RLS. Förfrågan måste komma från samma ursprung (Origin), och varje
 * användare får ett begränsat antal frågor per timme.
 */

import { randomUUID } from "node:crypto";

import { isUuid } from "@/server/access";
import type { AssistantEvent } from "@/server/assistant/protocol";
import { askAssistant, cleanQuestion } from "@/server/assistant/service";
import { createRateLimiter } from "@/server/rate-limit";
import { getActiveOrganization, getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";
/** En fråga med flera verktygsvarv kan ta en stund. */
export const maxDuration = 300;

/** Frågor per användare och timme (skydd mot kostnader vid missbruk, räknas per instans). */
const QUESTIONS_PER_HOUR = 60;
const limiter = createRateLimiter({ limit: QUESTIONS_PER_HOUR, windowMs: 3_600_000 });

function json(status: number, event: AssistantEvent): Response {
  return new Response(`${JSON.stringify(event)}\n`, {
    status,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return json(403, { type: "error", code: "forbidden", message: "Fel ursprung." });
  }
  const user = await getSessionUser();
  if (!user) {
    return json(401, { type: "error", code: "forbidden", message: "Du är inte inloggad." });
  }
  const organization = await getActiveOrganization();
  if (!organization) {
    return json(403, {
      type: "error",
      code: "forbidden",
      message: "Du är inte medlem i någon organisation.",
    });
  }

  let body: { question?: unknown; conversationId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { type: "error", code: "invalid", message: "Frågan saknas." });
  }
  const question = cleanQuestion(body.question);
  if (!question) {
    return json(400, {
      type: "error",
      code: "invalid",
      message: "Skriv en fråga (högst 2 000 tecken).",
    });
  }
  const decision = limiter.consume([{ key: `assistent:${user.userId}` }]);
  if (!decision.allowed) {
    const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
    return json(429, {
      type: "error",
      code: "invalid",
      message: `Du har ställt ${QUESTIONS_PER_HOUR} frågor den senaste timmen. Försök igen om ${minutes} min.`,
    });
  }
  const conversationId = isUuid(body.conversationId)
    ? body.conversationId.toLowerCase()
    : randomUUID();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: AssistantEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // webbläsaren har gått
        }
      };
      try {
        await askAssistant({
          viewer: { user, organization },
          question,
          conversationId,
          emit,
          signal: request.signal,
        });
      } catch (error) {
        console.error("[assistent] oväntat fel:", error);
        emit({
          type: "error",
          code: "internal",
          message: "Assistenten stannade på ett internt fel.",
        });
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
