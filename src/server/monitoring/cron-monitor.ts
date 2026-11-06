/**
 * Bevakning av att de schemalagda jobben alls körs: Sentry Cron Monitors.
 *
 * Varje körning av ett jobb skickar en incheckning ("in_progress", sedan "ok" eller "error")
 * med jobbets schema. Uteblir en incheckning (cron körs inte, fel CRON_SECRET, Vercel nere)
 * eller tar jobbet för lång tid skapar Sentry ett ärende och larmar enligt projektets
 * larmregler. Det är det enda larmet som fungerar när appen själv inte kör något.
 *
 * Incheckningen görs först när anropet är behörigt (CRON_SECRET stämmer), så att obehöriga
 * anrop inte räknas som körningar. Utan SENTRY_DSN görs ingenting. Kastar aldrig för fel i
 * själva bevakningen. Se docs/operations.md, "Felövervakning och larm".
 */

import "server-only";

import { sentryEnabled } from "./sentry";

export interface CronJob {
  /** Monitorns namn i Sentry, t.ex. 'binderlab-larm'. */
  readonly slug: string;
  /** Samma schema som i vercel.json eller pg_cron (UTC). */
  readonly schedule: string;
  /** Minuter efter utsatt tid innan en utebliven körning räknas som missad. */
  readonly checkinMarginMinutes: number;
  /** Minuter som en körning får ta innan den räknas som misslyckad. */
  readonly maxRuntimeMinutes: number;
}

export const CRON_JOBS = {
  larm: {
    slug: "binderlab-larm",
    schedule: "7 5 * * *",
    checkinMarginMinutes: 5,
    maxRuntimeMinutes: 5,
  },
  // Schemat sätts av pg_cron i Supabase (20261112000000_awish_synk_var_femte_minut.sql),
  // inte i vercel.json. En utebliven tick räknas som missad efter fem minuter.
  awish: {
    slug: "binderlab-awish",
    schedule: "*/5 * * * *",
    checkinMarginMinutes: 5,
    maxRuntimeMinutes: 2,
  },
  rapporter: {
    slug: "binderlab-rapporter",
    schedule: "17 5 1 * *",
    checkinMarginMinutes: 30,
    maxRuntimeMinutes: 15,
  },
} as const satisfies Record<string, CronJob>;

type SentryCron = {
  captureCheckIn(
    checkIn:
      | { monitorSlug: string; status: "in_progress" }
      | { monitorSlug: string; status: "ok" | "error"; checkInId: string; duration?: number },
    config?: {
      schedule: { type: "crontab"; value: string };
      checkinMargin?: number;
      maxRuntime?: number;
      timezone?: string;
    },
  ): string;
  flush(timeout?: number): Promise<boolean>;
};

async function sentry(): Promise<SentryCron | null> {
  if (!sentryEnabled()) return null;
  try {
    return (await import("@sentry/nextjs")) as unknown as SentryCron;
  } catch (error) {
    console.error("[monitoring] Sentry kunde inte laddas för cron", error);
    return null;
  }
}

/**
 * Kör jobbet med incheckningar till Sentry. `ok(result)` avgör om körningen lyckades
 * (t.ex. falskt när alla organisationer misslyckades); ett kastat fel ger "error" och kastas
 * vidare.
 */
export async function withCronMonitor<T>(
  job: CronJob,
  run: () => Promise<T>,
  ok: (result: T) => boolean = () => true,
  loader: () => Promise<SentryCron | null> = sentry,
): Promise<T> {
  const client = await loader();
  const started = Date.now();
  let checkInId: string | null = null;
  if (client) {
    try {
      checkInId = client.captureCheckIn(
        { monitorSlug: job.slug, status: "in_progress" },
        {
          schedule: { type: "crontab", value: job.schedule },
          checkinMargin: job.checkinMarginMinutes,
          maxRuntime: job.maxRuntimeMinutes,
          timezone: "Etc/UTC",
        },
      );
    } catch (error) {
      console.error("[monitoring] Incheckning till Sentry misslyckades", error);
    }
  }
  const finish = async (status: "ok" | "error") => {
    if (!client || checkInId === null) return;
    try {
      client.captureCheckIn({
        monitorSlug: job.slug,
        status,
        checkInId,
        duration: (Date.now() - started) / 1000,
      });
      await client.flush(2_000);
    } catch (error) {
      console.error("[monitoring] Incheckning till Sentry misslyckades", error);
    }
  };
  try {
    const result = await run();
    await finish(ok(result) ? "ok" : "error");
    return result;
  } catch (error) {
    await finish("error");
    throw error;
  }
}
