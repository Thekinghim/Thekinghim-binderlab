import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dbErrorMessage } from "./errors";
import { writeDevMail } from "./mail/dev-mailbox";
import { clientIp, resolveAppBaseUrl } from "./request-info";

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

describe("appens adress", () => {
  it("använder APP_URL i första hand", () => {
    expect(
      resolveAppBaseUrl({
        APP_ENV: "production",
        APP_URL: "https://app.binderlab.se/",
        VERCEL_URL: "x.vercel.app",
        VERCEL_BRANCH_URL: undefined,
      }),
    ).toBe("https://app.binderlab.se");
  });

  it("använder grenens Vercel-adress i preview", () => {
    expect(
      resolveAppBaseUrl({
        APP_ENV: "preview",
        APP_URL: undefined,
        VERCEL_URL: "abc.vercel.app",
        VERCEL_BRANCH_URL: "binderlab-git-x.vercel.app",
      }),
    ).toBe("https://binderlab-git-x.vercel.app");
  });

  it("litar bara på Host-rubriken lokalt", () => {
    const env = { APP_URL: undefined, VERCEL_URL: undefined, VERCEL_BRANCH_URL: undefined };
    expect(
      resolveAppBaseUrl({ ...env, APP_ENV: "development" }, headers({ host: "localhost:3200" })),
    ).toBe("http://localhost:3200");
    expect(
      resolveAppBaseUrl({ ...env, APP_ENV: "development" }, headers({ host: "evil.example/x" })),
    ).toBe("http://localhost:3000");
    expect(() =>
      resolveAppBaseUrl({ ...env, APP_ENV: "production" }, headers({ host: "evil.example" })),
    ).toThrow(/APP_URL/);
  });
});

describe("klientens IP", () => {
  it("tar Vercels rubriker först, annars sista adressen i x-forwarded-for", () => {
    // Det första värdet kan klienten skicka själv; det sista lade närmaste proxy till.
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("10.0.0.1");
    expect(
      clientIp(
        headers({ "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "198.51.100.9" }),
      ),
    ).toBe("198.51.100.9");
    expect(clientIp(headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(headers({}))).toBe("okänd");
  });
});

describe("databasfel", () => {
  const pg = (code: string, message: string) => ({ cause: { code, message, severity: "ERROR" } });

  it("visar BL-meddelanden och döljer andra", () => {
    expect(dbErrorMessage(pg("BL012", "Inbjudan har gått ut."))).toBe("Inbjudan har gått ut.");
    expect(dbErrorMessage(pg("42501", "new row violates row-level security policy"))).toBe(
      "Du har inte behörighet till det här.",
    );
    expect(dbErrorMessage(pg("XX000", "internt fel med detaljer"))).toBe(
      "Något gick fel. Försök igen.",
    );
    expect(dbErrorMessage(new Error("inte från databasen"), "Reserv.")).toBe("Reserv.");
  });
});

describe("dev-brevlådan", () => {
  it("skriver en .eml-fil med kodad ämnesrad", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "binderlab-mail-"));
    try {
      const file = await writeDevMail(
        { to: "anna@example.se", subject: "Välkommen", text: "Hej\nrad 2" },
        dir,
      );
      const content = await readFile(file, "utf8");
      expect(content).toContain("To: anna@example.se\r\n");
      expect(content).toContain(
        `Subject: =?UTF-8?B?${Buffer.from("Välkommen").toString("base64")}?=`,
      );
      expect(content).toContain("Hej\r\nrad 2");
      await expect(
        writeDevMail({ to: "a@b.se\r\nBcc: x@y.se", subject: "x", text: "" }, dir),
      ).rejects.toThrow(/radbrytningar/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
