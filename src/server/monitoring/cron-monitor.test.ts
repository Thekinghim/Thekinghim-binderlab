import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { CRON_JOBS, withCronMonitor } = await import("./cron-monitor");

function fakeSentry() {
  const checkIns: { checkIn: Record<string, unknown>; config?: Record<string, unknown> }[] = [];
  const client = {
    captureCheckIn: vi.fn((checkIn: Record<string, unknown>, config?: Record<string, unknown>) => {
      checkIns.push({ checkIn, config });
      return "check-in-1";
    }),
    flush: vi.fn(async () => true),
  };
  return { client, checkIns, loader: async () => client };
}

describe("withCronMonitor (Sentry Cron Monitors)", () => {
  it("schemana är desamma som i vercel.json", () => {
    const root = path.resolve(__dirname, "../../..");
    const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const byPath = new Map(config.crons.map((c) => [c.path, c.schedule]));
    expect(byPath.get("/api/cron/larm")).toBe(CRON_JOBS.larm.schedule);
    expect(byPath.get("/api/cron/rapporter")).toBe(CRON_JOBS.rapporter.schedule);
  });

  it("checkar in med schemat och sedan ok", async () => {
    const { client, checkIns, loader } = fakeSentry();
    const result = await withCronMonitor(CRON_JOBS.larm, async () => 42, undefined, loader);
    expect(result).toBe(42);
    expect(checkIns[0]).toEqual({
      checkIn: { monitorSlug: "binderlab-larm", status: "in_progress" },
      config: {
        schedule: { type: "crontab", value: "*/10 * * * *" },
        checkinMargin: 5,
        maxRuntime: 5,
        timezone: "Etc/UTC",
      },
    });
    expect(checkIns[1]?.checkIn).toMatchObject({
      monitorSlug: "binderlab-larm",
      status: "ok",
      checkInId: "check-in-1",
    });
    expect(client.flush).toHaveBeenCalled();
  });

  it("ger error när körningen inte lyckades eller kastar, och kastar vidare", async () => {
    const a = fakeSentry();
    await withCronMonitor(
      CRON_JOBS.rapporter,
      async () => ({ errors: 1 }),
      (r) => r.errors === 0,
      a.loader,
    );
    expect(a.checkIns[1]?.checkIn.status).toBe("error");

    const b = fakeSentry();
    await expect(
      withCronMonitor(
        CRON_JOBS.rapporter,
        async () => {
          throw new Error("databasen svarar inte");
        },
        undefined,
        b.loader,
      ),
    ).rejects.toThrow("databasen svarar inte");
    expect(b.checkIns.map((c) => c.checkIn.status)).toEqual(["in_progress", "error"]);
  });

  it("utan Sentry körs jobbet ändå, och fel i bevakningen stoppar inget", async () => {
    expect(
      await withCronMonitor(
        CRON_JOBS.larm,
        async () => "ok",
        undefined,
        async () => null,
      ),
    ).toBe("ok");
    const broken = {
      captureCheckIn: vi.fn(() => {
        throw new Error("SDK trasig");
      }),
      flush: vi.fn(async () => true),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await withCronMonitor(
        CRON_JOBS.larm,
        async () => 1,
        undefined,
        async () => broken,
      ),
    ).toBe(1);
    spy.mockRestore();
  });
});
