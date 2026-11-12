/**
 * En falsk Fortnox för testerna: token-tjänsten och den del av API:t som appen använder.
 * Den håller på reglerna som spelar roll (se developer.fortnox.se, sammanfattat i ADR 31):
 *
 * - Åtkomsttoken gäller en timme. Refresh-token byts vid varje förnyelse och den gamla
 *   gäller inte efteråt (ett andra försök med samma ger 400 invalid_grant).
 * - En kod från godkännandet gäller en gång, och PKCE kontrolleras.
 * - Högst 25 anrop per 5 sekunder per token, annars 429.
 * - Ett verifikat i en låst period, utanför alla räkenskapsår, på ett konto som saknas eller
 *   är inaktivt, i en serie som saknas eller som inte balanserar nekas med 400.
 * - Dubbletter stoppas INTE (som i riktiga Fortnox): samma verifikat två gånger ger två
 *   verifikat. Det är appens utkorg som ska hindra det.
 *
 * Fel kan läggas in: `dropNextVoucherReply` skapar verifikatet men bryter anslutningen innan
 * svaret (ett tappat svar), `failNext` svarar med en vald status utan att göra något.
 *
 * Styrs i samma process (testerna) eller över HTTP under /__fake (e2e, scripts/dev).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeVoucher {
  readonly series: string;
  readonly number: number;
  readonly year: number;
  readonly date: string;
  readonly description: string;
  readonly rows: readonly { account: number; debit: number; credit: number; text: string }[];
}

interface Grant {
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scope: string;
}

export interface FakeFortnoxOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly now?: () => number;
}

const ACCESS_MS = 3_600_000;
const REFRESH_MS = 45 * 86_400_000;

export class FakeFortnox {
  readonly clientId: string;
  readonly clientSecret: string;
  companyName = "Testbolaget AB";
  databaseNumber = 123456;
  /** Konton som finns: nummer → aktivt. */
  accounts = new Map<number, boolean>();
  series = new Set<string>(["A", "B", "C"]);
  years: { id: number; from: string; to: string }[] = [
    { id: 1, from: "2025-01-01", to: "2025-12-31" },
    { id: 2, from: "2026-01-01", to: "2026-12-31" },
    { id: 3, from: "2027-01-01", to: "2027-12-31" },
  ];
  lockedUntil: string | null = null;
  vouchers: FakeVoucher[] = [];
  /** Hastighetsgränsen (25 per 5 sekunder). Av i tester som inte handlar om den. */
  rateLimit = false;
  /** Skapa nästa verifikat men bryt anslutningen före svaret. */
  dropNextVoucherReply = false;
  /** Svara så här på nästa API-anrop (inte token) utan att göra något. */
  failNext: { status: number; body?: unknown; path?: RegExp }[] = [];
  /** Token-tjänsten svarar 500 så här många gånger. */
  tokenOutages = 0;
  requests: { method: string; path: string; status: number }[] = [];
  tokenRequests: { grant: string; status: number }[] = [];

  private readonly grants: Grant[] = [];
  private readonly codes = new Map<
    string,
    { challenge: string | null; scope: string; redirectUri: string; expiresAt: number }
  >();
  private readonly usedRefresh = new Set<string>();
  private readonly hits = new Map<string, number[]>();
  private server: Server | null = null;
  private offsetMs = 0;
  private readonly clock: () => number;

  constructor(options: FakeFortnoxOptions = {}) {
    this.clientId = options.clientId ?? "fake-client-id";
    this.clientSecret = options.clientSecret ?? "fake-client-secret";
    this.clock = options.now ?? Date.now;
    for (const n of [1460, 1580, 1930, 2611, 2616, 2990, 3000, 3211, 4010, 4990, 5010, 6040]) {
      this.accounts.set(n, true);
    }
    for (const n of [4960, 6090, 6570, 6590, 6310, 5420, 5610, 6990]) this.accounts.set(n, true);
  }

  now(): number {
    return this.clock() + this.offsetMs;
  }

  /** Flyttar den falska klockan framåt (t.ex. förbi en timme, så att token går ut). */
  advance(ms: number): void {
    this.offsetMs += ms;
  }

  get url(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error("Den falska Fortnox-servern är inte startad.");
    return `http://127.0.0.1:${address.port}`;
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** En kod som om ägaren just godkänt kopplingen (för tester utan webbläsare). */
  issueCode(redirectUri: string, challenge: string | null = null, scope = "bookkeeping"): string {
    const code = randomBytes(12).toString("hex");
    this.codes.set(code, { challenge, scope, redirectUri, expiresAt: this.now() + 600_000 });
    return code;
  }

  /** Gör alla åtkomsttoken ogiltiga nu (som om en timme gått). */
  expireAccessTokens(): void {
    for (const g of this.grants) g.accessExpiresAt = 0;
  }

  /** Återkallar allt: nästa förnyelse ger invalid_grant. */
  revokeAll(): void {
    for (const g of this.grants) {
      g.accessExpiresAt = 0;
      g.refreshExpiresAt = 0;
    }
  }

  private grant(scope: string): Grant {
    const g: Grant = {
      accessToken: `at_${randomBytes(18).toString("hex")}`,
      refreshToken: `rt_${randomBytes(18).toString("hex")}`,
      accessExpiresAt: this.now() + ACCESS_MS,
      refreshExpiresAt: this.now() + REFRESH_MS,
      scope,
    };
    this.grants.push(g);
    return g;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(text);
  }

  private error(res: ServerResponse, status: number, code: number, message: string): void {
    this.send(res, status, { ErrorInformation: { error: 1, message, code } });
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path.startsWith("/__fake")) return this.control(req, res, url);
    if (path === "/oauth-v1/auth") return this.authorize(res, url);
    if (path === "/oauth-v1/token") return this.token(req, res);
    if (path === "/oauth-v1/revoke") {
      const form = new URLSearchParams(await this.body(req));
      const g = this.grants.find((x) => x.refreshToken === form.get("token"));
      if (g) {
        g.accessExpiresAt = 0;
        g.refreshExpiresAt = 0;
      }
      return this.send(res, 200, { revoked: true });
    }
    if (path.startsWith("/3/")) {
      const before = res.statusCode;
      await this.api(req, res, url);
      this.requests.push({
        method: req.method ?? "GET",
        path: `${path}${url.search}`,
        status: res.writableEnded || res.headersSent ? res.statusCode : before,
      });
      return;
    }
    this.send(res, 404, { message: "not found" });
  }

  private authorize(res: ServerResponse, url: URL): void {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    if (q.get("client_id") !== this.clientId || q.get("response_type") !== "code" || !redirectUri) {
      return this.send(res, 400, { error: "invalid_request" });
    }
    const code = this.issueCode(
      redirectUri,
      q.get("code_challenge"),
      q.get("scope") ?? "bookkeeping",
    );
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await this.body(req));
    const grantType = form.get("grant_type") ?? "";
    const done = (status: number, body: unknown) => {
      this.tokenRequests.push({ grant: grantType, status });
      this.send(res, status, body);
    };
    if (this.tokenOutages > 0) {
      this.tokenOutages -= 1;
      return done(500, { error: "server_error" });
    }
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    if (req.headers.authorization !== expected) return done(401, { error: "invalid_client" });
    const reply = (g: Grant) =>
      done(200, {
        access_token: g.accessToken,
        refresh_token: g.refreshToken,
        scope: g.scope,
        expires_in: ACCESS_MS / 1000,
        token_type: "bearer",
      });
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const entry = this.codes.get(code);
      this.codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      const challengeOk =
        !entry?.challenge ||
        createHash("sha256").update(verifier).digest("base64url") === entry.challenge;
      if (
        !entry ||
        entry.expiresAt < this.now() ||
        entry.redirectUri !== form.get("redirect_uri") ||
        !challengeOk
      ) {
        return done(400, { error: "invalid_grant", error_description: "Invalid code" });
      }
      return reply(this.grant(entry.scope));
    }
    if (grantType === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const index = this.grants.findIndex((g) => g.refreshToken === token);
      const old = index >= 0 ? this.grants[index]! : null;
      if (!old || this.usedRefresh.has(token) || old.refreshExpiresAt < this.now()) {
        return done(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
      }
      // Rotation: den gamla refresh-token och dess åtkomsttoken gäller inte längre.
      this.usedRefresh.add(token);
      this.grants.splice(index, 1);
      return reply(this.grant(old.scope));
    }
    return done(400, { error: "unsupported_grant_type" });
  }

  private yearFor(date: string) {
    return this.years.find((y) => y.from <= date && date <= y.to) ?? null;
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    // Läs alltid hela frågan först: ett svar innan kroppen är läst lämnar anslutningen i ett
    // läge där nästa anrop på samma anslutning hänger.
    const raw = await this.body(req);
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const grant = this.grants.find((g) => g.accessToken === token);
    if (!grant || grant.accessExpiresAt < this.now()) {
      return this.send(res, 401, { message: "unauthorized" });
    }
    if (this.rateLimit) {
      const t = this.now();
      const list = (this.hits.get(token) ?? []).filter((x) => t - x < 5_000);
      if (list.length >= 25) {
        this.hits.set(token, list);
        return this.send(res, 429, { message: "Too Many Requests" });
      }
      list.push(t);
      this.hits.set(token, list);
    }
    const failIndex = this.failNext.findIndex((f) => !f.path || f.path.test(path));
    if (failIndex >= 0) {
      const [fail] = this.failNext.splice(failIndex, 1);
      return this.send(res, fail!.status, fail!.body ?? { message: "fel" });
    }
    const method = req.method ?? "GET";
    const yearParam = Number(url.searchParams.get("financialyear"));

    if (method === "GET" && path === "/3/companyinformation") {
      return this.send(res, 200, {
        CompanyInformation: { CompanyName: this.companyName, DatabaseNumber: this.databaseNumber },
      });
    }
    if (method === "GET" && path === "/3/financialyears") {
      const date = url.searchParams.get("date");
      const list = date ? this.years.filter((y) => y.from <= date && date <= y.to) : this.years;
      return this.send(res, 200, {
        FinancialYears: list.map((y) => ({
          Id: y.id,
          FromDate: y.from,
          ToDate: y.to,
          AccountingMethod: "ACCRUAL",
        })),
      });
    }
    if (method === "GET" && path === "/3/settings/lockedperiod") {
      return this.send(res, 200, {
        LockedPeriod: this.lockedUntil ? { EndDate: this.lockedUntil } : {},
      });
    }
    if (method === "GET" && path === "/3/voucherseries") {
      return this.send(res, 200, {
        VoucherSeriesCollection: [...this.series].map((Code) => ({ Code, Manual: true })),
      });
    }
    const account = /^\/3\/accounts\/(\d+)$/.exec(path);
    if (method === "GET" && account) {
      const n = Number(account[1]);
      if (!this.accounts.has(n)) return this.error(res, 404, 2000423, "Kan inte hitta kontot.");
      return this.send(res, 200, { Account: { Number: n, Active: this.accounts.get(n) } });
    }
    const sublist = /^\/3\/vouchers\/sublist\/([A-Za-z0-9]+)$/.exec(path);
    if (method === "GET" && sublist) {
      const from = url.searchParams.get("fromdate") ?? "0000-00-00";
      const to = url.searchParams.get("todate") ?? "9999-99-99";
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 100);
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const all = this.vouchers.filter(
        (v) => v.series === sublist[1] && v.year === yearParam && v.date >= from && v.date <= to,
      );
      return this.send(res, 200, {
        MetaInformation: {
          "@TotalPages": Math.max(1, Math.ceil(all.length / limit)),
          "@CurrentPage": page,
          "@TotalResources": all.length,
        },
        Vouchers: all.slice((page - 1) * limit, page * limit).map((v) => ({
          VoucherSeries: v.series,
          VoucherNumber: v.number,
          Year: v.year,
          TransactionDate: v.date,
          Description: v.description,
        })),
      });
    }
    if (method === "POST" && path === "/3/vouchers") {
      return this.createVoucher(raw, res, yearParam);
    }
    this.send(res, 404, { message: "not found" });
  }

  private async createVoucher(raw: string, res: ServerResponse, yearParam: number): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.error(res, 400, 2001392, "Tom eller felaktig data.");
    }
    const v = (parsed as { Voucher?: Record<string, unknown> }).Voucher;
    const rows = Array.isArray(v?.VoucherRows) ? (v.VoucherRows as Record<string, unknown>[]) : [];
    const date = typeof v?.TransactionDate === "string" ? v.TransactionDate : "";
    const series = typeof v?.VoucherSeries === "string" ? v.VoucherSeries : "";
    const description = typeof v?.Description === "string" ? v.Description : "";
    if (!v || rows.length < 2 || !description || description.length > 200) {
      return this.error(res, 400, 2000588, "Ogiltig parameter i anropet.");
    }
    const year = this.yearFor(date);
    if (!year || (Number.isFinite(yearParam) && yearParam > 0 && year.id !== yearParam)) {
      return this.error(res, 400, 2000403, "Datumet ligger inte i något räkenskapsår.");
    }
    if (this.lockedUntil && date <= this.lockedUntil) {
      return this.error(res, 400, 2000401, `Perioden är låst till och med ${this.lockedUntil}.`);
    }
    if (!this.series.has(series)) {
      return this.error(res, 400, 2000427, "Verifikationsserien finns inte.");
    }
    let debit = 0;
    let credit = 0;
    const clean = [];
    for (const r of rows) {
      const n = Number(r.Account);
      if (this.accounts.get(n) !== true) {
        return this.error(res, 400, 2000423, "Kan inte hitta kontot.");
      }
      const d = Math.round(Number(r.Debit ?? 0) * 100);
      const c = Math.round(Number(r.Credit ?? 0) * 100);
      if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) {
        return this.error(res, 400, 2000588, "Ogiltig parameter i anropet.");
      }
      const text = typeof r.TransactionInformation === "string" ? r.TransactionInformation : "";
      if (text.length > 100) return this.error(res, 400, 2000588, "Ogiltig parameter i anropet.");
      debit += d;
      credit += c;
      clean.push({ account: n, debit: d, credit: c, text });
    }
    if (debit !== credit || debit === 0) {
      return this.error(res, 400, 2000106, "Verifikationen balanserar inte.");
    }
    const number =
      this.vouchers
        .filter((x) => x.series === series && x.year === year.id)
        .reduce((max, x) => Math.max(max, x.number), 0) + 1;
    this.vouchers.push({ series, number, year: year.id, date, description, rows: clean });
    if (this.dropNextVoucherReply) {
      this.dropNextVoucherReply = false;
      res.statusCode = 201;
      res.destroy();
      return;
    }
    this.send(res, 201, {
      Voucher: {
        "@url": `/3/vouchers/${series}/${number}?financialyear=${year.id}`,
        VoucherSeries: series,
        VoucherNumber: number,
        Year: year.id,
        TransactionDate: date,
        Description: description,
      },
    });
  }

  /** Styrning över HTTP (e2e): GET /__fake/state, POST /__fake/set med JSON. */
  private async control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/__fake/state") {
      return this.send(res, 200, {
        vouchers: this.vouchers,
        lockedUntil: this.lockedUntil,
        requests: this.requests.length,
      });
    }
    if (url.pathname === "/__fake/set" && req.method === "POST") {
      const o = JSON.parse((await this.body(req)) || "{}") as Record<string, unknown>;
      if ("lockedUntil" in o) this.lockedUntil = (o.lockedUntil as string | null) ?? null;
      if (typeof o.removeAccount === "number") this.accounts.delete(o.removeAccount);
      if (typeof o.addAccount === "number") this.accounts.set(o.addAccount, true);
      if (o.revokeAll === true) this.revokeAll();
      if (o.expireAccessTokens === true) this.expireAccessTokens();
      if (o.reset === true) {
        this.vouchers = [];
        this.lockedUntil = null;
      }
      return this.send(res, 200, { ok: true });
    }
    this.send(res, 404, { message: "not found" });
  }
}
