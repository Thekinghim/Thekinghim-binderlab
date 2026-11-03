import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { dbErrorMessage, safeErrorForLog } from "@/server/errors";

const { AwishSetupError, rpcError } = await import("./manage");

const SECRET = "HEMLIG_APPSECRET_9f8e7d";
const KEY = "HEMLIG_APPKEY_1a2b3c";

function failedRpc(code: string, message: string): DrizzleQueryError {
  const pg = Object.assign(new Error(message), { code, severity: "ERROR" });
  return new DrizzleQueryError(
    "select public.awish_save_credentials($1, $2, $3, $4, $5)",
    ["org", "id", "app", SECRET, KEY],
    pg,
  );
}

describe("awish_save_credentials: fel läcker aldrig parametrarna", () => {
  it("drizzle-felet har hemligheterna i meddelandet (därför saneras det)", () => {
    expect(failedRpc("57014", "canceling statement due to statement timeout").message).toContain(
      SECRET,
    );
  });

  it("statement_timeout (57014) blir ett fel utan parametrar och utan orsak", () => {
    let thrown: unknown;
    try {
      rpcError(failedRpc("57014", "canceling statement due to statement timeout"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const logged = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(KEY);
    expect((thrown as Error).message).toMatch(/SQLSTATE 57014/);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });

  it("serialiseringsfel ger fortfarande ett svenskt meddelande", () => {
    try {
      rpcError(failedRpc("40001", "could not serialize access"));
    } catch (error) {
      expect(dbErrorMessage(error)).toMatch(/Någon annan ändrade samtidigt/);
    }
  });

  it("funktionens egna fel (22023, 42501, P0002) visas som de är", () => {
    expect(() => rpcError(failedRpc("42501", "Bara ägare och administratörer får spara."))).toThrow(
      AwishSetupError,
    );
  });

  it("safeErrorForLog skär bort params ur loggen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    console.error("[datakallor]", safeErrorForLog(failedRpc("XX000", "internal error")));
    const out = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(KEY);
    expect(out).toContain("XX000");
  });
});
