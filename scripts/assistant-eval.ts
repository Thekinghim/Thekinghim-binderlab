/**
 * Utvärdering av assistenten mot Claude API (opt-in, kostar pengar). Ställer några av
 * frågorna i src/server/assistant/eval/cases.ts som ägaren i den seedade organisationen
 * och skriver ut verktygen, kontrollen av talen, svaret och kostnaden.
 *
 *   npx tsx scripts/assistant-eval.ts --live              # 5 frågor (standard)
 *   npx tsx scripts/assistant-eval.ts --live --antal 3    # högst 8
 *   npx tsx scripts/assistant-eval.ts --live --id varfor,forlust
 *
 * Kräver ANTHROPIC_API_KEY och en seedad databas (DATABASE_URL, npm run db:seed). Frågorna
 * loggas i assistant_logs och räknas mot månadstaket (AI_MONTHLY_BUDGET_SEK) som vanligt.
 * Utan --live körs ingenting.
 */

import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";

import { config } from "dotenv";

import type { AssistantEvent } from "../src/server/assistant/protocol";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "react-server"],
      });
    }
    return nextResolve(specifier, context);
  },
});

config({ path: [".env.local", ".env"], quiet: true });

const MAX_CASES = 8;
const OWNER_EMAIL = process.env.EVAL_OWNER_EMAIL ?? "agare@binderlab.local";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.log("Utvärderingen mot Claude API kostar pengar. Kör med --live (högst 8 frågor).");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY saknas.");

  const { sql } = await import("drizzle-orm");
  const { getServiceDb, closeServiceDb } = await import("../src/db/client");
  const { listOrganizationsFor } = await import("../src/server/access");
  const { EVAL_CASES, EVAL_NOW } = await import("../src/server/assistant/eval/cases");
  const { pageContextFromUrl } = await import("../src/server/assistant/page-context");
  const { askAssistant } = await import("../src/server/assistant/service");
  const { costOre, budgetFrom } = await import("../src/server/assistant/advisor/pricing");
  const { getAssistantConfig } = await import("../src/server/assistant/config");

  const ids = arg("--id")
    ?.split(",")
    .map((s) => s.trim());
  const count = Math.min(MAX_CASES, Math.max(1, Number(arg("--antal") ?? 5) || 5));
  const cases = (ids ? EVAL_CASES.filter((c) => ids.includes(c.id)) : EVAL_CASES)
    .filter((c) => c.role === undefined || c.role === "owner")
    .slice(0, count);

  const cfg = getAssistantConfig();
  if (cfg.status !== "ready" || cfg.provider !== "anthropic") {
    throw new Error("Assistenten är inte inställd för Claude API (ASSISTANT_PROVIDER=anthropic).");
  }
  const db = getServiceDb();
  try {
    const [row] = Array.from(
      await db.execute(sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`),
    ) as Array<{ id: string }>;
    if (!row) throw new Error(`Hittar inte ${OWNER_EMAIL}. Kör npm run db:seed.`);
    const user = { userId: row.id, email: OWNER_EMAIL };
    const organization = (await listOrganizationsFor(user))[0];
    if (!organization) throw new Error("Ägaren saknar organisation.");
    const { usdSek } = budgetFrom(process.env);

    let passed = 0;
    let totalOre = 0;
    for (const c of cases) {
      const events: AssistantEvent[] = [];
      const [pathname, search = ""] = (c.page ?? "").split("?");
      await askAssistant({
        viewer: { user, organization },
        question: c.question,
        conversationId: randomUUID(),
        emit: (e) => events.push(e),
        now: new Date(EVAL_NOW),
        page: c.page ? pageContextFromUrl(pathname!, search ? `?${search}` : "") : null,
      });
      const calls = events.flatMap((e) => (e.type === "tool_call" ? [e] : []));
      const done = events.find((e) => e.type === "done");
      const error = events.find((e) => e.type === "error");
      const used = calls.find((x) => x.name === c.tool);
      const inputOk =
        !!used &&
        Object.entries(c.input ?? {}).every(
          ([k, v]) => JSON.stringify(used.input[k]) === JSON.stringify(v),
        );
      const ok = !!done && done.status === "answered" && !!used;
      if (ok) passed += 1;
      const cost =
        done && done.type === "done"
          ? costOre(
              cfg.model,
              {
                inputTokens: done.usage.inputTokens,
                outputTokens: done.usage.outputTokens,
                cacheReadTokens: done.usage.cacheReadTokens,
                cacheWriteTokens: done.usage.cacheWriteTokens ?? 0,
              },
              usdSek,
            )
          : 0;
      totalOre += cost;
      console.log(`\n${ok ? "OK " : "FEL"} ${c.id}: ${c.question}`);
      console.log(
        `    verktyg: ${calls.map((x) => x.name).join(" → ") || "inga"} (väntat ${c.tool}${c.input ? `, parametrar ${inputOk ? "rätt" : "fel"}` : ""})`,
      );
      if (done && done.type === "done") {
        console.log(
          `    status: ${done.status}, tal ej i underlaget: ${done.verification.unverified.join(", ") || "inga"}, knappar: ${(done.actions ?? []).map((a) => a.label).join(", ") || "inga"}`,
        );
        console.log(
          `    tokens: in ${done.usage.inputTokens}, ut ${done.usage.outputTokens}, cache läst ${done.usage.cacheReadTokens}, skrivet ${done.usage.cacheWriteTokens ?? 0}; ca ${(cost / 100).toFixed(2)} kr`,
        );
        console.log(`    svar: ${done.answer.replace(/\n/g, "\n          ")}`);
      } else if (error && error.type === "error") {
        console.log(`    fel: ${error.message}`);
      }
    }
    console.log(
      `\n${passed} av ${cases.length} rätt. Kostnad ca ${(totalOre / 100).toFixed(2)} kr (${cfg.model}, insats ${cfg.effort}).`,
    );
  } finally {
    await closeServiceDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
