/**
 * LIVE-test (inte i CI): riktig Claude-nyckel mot den lokala demodatabasen.
 *
 *   set -a; . /root/.binderlab-anthropic.env; set +a
 *   AI_LIVE=1 AI_LIVE_DATABASE_URL=postgres://…/binderlab_ai_dev \
 *     NODE_USE_ENV_PROXY=1 npx vitest run -c vitest.db.config.ts test/db/ai-live.test.ts
 *
 * Hoppas över utan AI_LIVE=1. Skriver frågor, svar och förslag, aldrig nyckeln.
 */

import { describe, expect, it } from "vitest";

const live = process.env.AI_LIVE === "1" && !!process.env.AI_LIVE_DATABASE_URL;
if (live) process.env.DATABASE_URL = process.env.AI_LIVE_DATABASE_URL;

const QUESTIONS = [
  "Vilken titel tjänar vi mest på senaste 30 dagarna?",
  "Vad ska jag fylla på i automaten?",
  "Hur mycket ska Sega gubben få i oktober?",
];

async function demoOwner() {
  const { getServiceDb } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { listOrganizationsFor } = await import("@/server/access");
  const [u] = Array.from(
    await getServiceDb().execute(
      sql`select id, email from auth.users where email = 'demo@binderlab.local'`,
    ),
  ) as Array<{ id: string; email: string }>;
  if (!u) throw new Error("Demon saknas: npm run db:seed-demo -- --url <AI_LIVE_DATABASE_URL>");
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.slug === "nordljus-demo");
  if (!organization) throw new Error("Demoorganisationen saknas.");
  return { user, organization };
}

describe.skipIf(!live)("LIVE: Claude mot demodatan", () => {
  it("assistenten svarar på tre frågor", { timeout: 600_000 }, async () => {
    const { askAssistant } = await import("@/server/assistant/service");
    const viewer = await demoOwner();
    for (const question of QUESTIONS) {
      let answer = "";
      let error = "";
      let meta = "";
      const tools: string[] = [];
      const res = await askAssistant({
        viewer,
        question,
        conversationId: crypto.randomUUID(),
        emit: (e) => {
          if (e.type === "done") {
            answer = e.answer;
            meta = `${e.status}, ${e.usage.turns} varv, in ${e.usage.inputTokens} (cache ${e.usage.cacheReadTokens}), ut ${e.usage.outputTokens}, ${e.durationMs} ms, okontrollerade: ${e.verification.unverified.join(" ") || "-"}`;
          }
          if (e.type === "error") error = e.message;
          if (e.type === "tool_result") tools.push(`${e.call.name}${e.call.ok ? "" : " (fel)"}`);
        },
      });
      console.log(
        `\n### ${question}\n${answer || `FEL: ${error}`}\n[verktyg: ${tools.join(", ")}] [${meta}]`,
      );
      expect(error).toBe("");
      expect(res.status).toBe("answered");
    }
  });

  it("rådgivaren ger förslag som klarar kontrollen", { timeout: 300_000 }, async () => {
    const { runAdvisor, loadAdvisorStateFor, loadSnapshotFor } =
      await import("@/server/assistant/advisor/service");
    const viewer = await demoOwner();
    const now = new Date();
    const snapshot = await loadSnapshotFor(viewer, now);
    console.log(`\nUnderlag: ${JSON.stringify(snapshot).length} tecken`);
    const r = await runAdvisor({ viewer, trigger: "manual", now });
    console.log(`\n### Rådgivaren: ${JSON.stringify(r, null, 1)}`);
    const state = await loadAdvisorStateFor(viewer, now);
    for (const s of state?.suggestions ?? []) {
      console.log(
        `\n${s.rank}. ${s.title} [${s.confidence}, ~${s.effectSekMonth} kr/mån]\n   Varför: ${s.why}\n   Gör: ${s.action}`,
      );
    }
    expect(["ok", "empty"]).toContain(r.status);
  });
});
