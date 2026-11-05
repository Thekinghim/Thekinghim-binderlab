/**
 * Låtsas-Awish webbpanel för testerna: en riktig http-server på 127.0.0.1 som härmar
 * dash.awish.vip/graphql. Den kontrollerar Appid-headern och att payloaden är signerad
 * (web-sign.ts), loggar in med e-post/lösenord, håller fack i minnet och svarar på
 * MachinesLite, Products och UpdateProduct. Används av enhetstester och databastester;
 * aldrig av appen, och den når aldrig riktiga Awish.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { AWISH_WEB_APP_KEY, awishCheckSignature, awishDecode } from "../web-sign";

export interface FakeWebProduct {
  id: number;
  goodId: number | null;
  goodName: string | null;
  status: boolean;
  currentInventory: number;
  capacity: number | null;
  channelName: string | null;
}

export interface FakeWebMachine {
  id: number;
  machineNo: string | null;
  name: string | null;
}

export interface FakeWebState {
  appId: string;
  appKey: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  machines: FakeWebMachine[];
  /** Fack per Awish-automat (machine_id som sträng). */
  products: Record<string, FakeWebProduct[]>;
  /** Antal kommande anrop som svarar med HTTP 503 (Awish nere). */
  failNext: number;
  /** GraphQL-fel att svara med vid nästa anrop (töms efter ett anrop). */
  nextError: { message: string; code?: string } | null;
  /** Logg över anropen, för att prova vad som faktiskt skickades. */
  calls: Array<{ operationName: string; variables: Record<string, unknown>; token: string | null }>;
}

export interface FakeWeb {
  baseUrl: string;
  state: FakeWebState;
  stop(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

export async function startFakeAwishWeb(initial: Partial<FakeWebState> = {}): Promise<FakeWeb> {
  const state: FakeWebState = {
    appId: "dsc6805f597d8c411e",
    appKey: AWISH_WEB_APP_KEY,
    email: "butik@example.com",
    password: "hemligt",
    accessToken: "access-token-test",
    refreshToken: "refresh-token-test",
    machines: [{ id: 1001, machineNo: "BL-001", name: "Sega gubbens automat" }],
    products: {},
    failNext: 0,
    nextError: null,
    calls: [],
    ...initial,
  };

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/graphql")) {
      send(res, 404, { errors: [{ message: "not found" }] });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (state.failNext > 0) {
        state.failNext -= 1;
        send(res, 503, { errors: [{ message: "service unavailable" }] });
        return;
      }
      // Awish-mellanprogrammets headerkontroll.
      if (req.headers["appid"] !== state.appId) {
        send(res, 200, {
          errors: [{ message: "appid is missing", extensions: { code: "UNAUTHENTICATED" } }],
        });
        return;
      }
      let payload: { operationName?: string; query?: string; variables?: Record<string, unknown> };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(res, 400, { errors: [{ message: "bad request" }] });
        return;
      }
      const op = payload.operationName ?? "";
      const variables = payload.variables ?? {};
      const authHeader = req.headers["authorization"];
      const token =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : null;
      state.calls.push({ operationName: op, variables, token });

      if (state.nextError) {
        const err = state.nextError;
        state.nextError = null;
        send(res, 200, {
          errors: [{ message: err.message, extensions: err.code ? { code: err.code } : undefined }],
        });
        return;
      }

      // Signaturen på "input"-strängen kontrolleras, precis som riktiga Awish.
      const checkSignedInput = (): Record<string, unknown> | null => {
        const input = variables.input;
        if (typeof input !== "string") return null;
        let decoded: Record<string, unknown>;
        try {
          decoded = awishDecode(input);
        } catch {
          return null;
        }
        if (!awishCheckSignature(decoded as never, state.appKey)) return null;
        return decoded;
      };

      if (op === "Signin") {
        const decoded = checkSignedInput();
        if (!decoded) {
          send(res, 200, {
            errors: [{ message: "bad signature", extensions: { code: "UNAUTHENTICATED" } }],
          });
          return;
        }
        if (decoded.email !== state.email || decoded.password !== state.password) {
          send(res, 200, {
            errors: [
              { message: "incorrect email or password", extensions: { code: "UNAUTHENTICATED" } },
            ],
          });
          return;
        }
        send(res, 200, {
          data: {
            signin: {
              access_token: state.accessToken,
              refresh_token: state.refreshToken,
              expires_in: 7200,
            },
          },
        });
        return;
      }

      // Alla andra anrop kräver giltig token.
      if (token !== state.accessToken) {
        send(res, 200, {
          errors: [{ message: "token invalid", extensions: { code: "UNAUTHENTICATED" } }],
        });
        return;
      }

      if (op === "MachinesLite") {
        send(res, 200, {
          data: {
            machinesLite: state.machines.map((m) => ({
              id: m.id,
              machine_no: m.machineNo,
              name: m.name,
            })),
          },
        });
        return;
      }

      if (op === "Products") {
        const decoded = checkSignedInput();
        if (!decoded) {
          send(res, 200, { errors: [{ message: "bad signature" }] });
          return;
        }
        const machineId = String(decoded.machine_id ?? "");
        const list = state.products[machineId] ?? [];
        send(res, 200, {
          data: {
            products: list.map((p) => ({
              id: p.id,
              good_id: p.goodId,
              status: p.status,
              current_inventory: p.currentInventory,
              good: p.goodId == null ? null : { id: p.goodId, name: p.goodName },
              channel: { name: p.channelName, total: p.capacity },
            })),
          },
        });
        return;
      }

      if (op === "UpdateProduct") {
        // Som riktiga Awish: updateProduct ger ett skalärt värde, så ett urval ({ … }) nekas.
        const q = String((payload as { query?: unknown }).query ?? "");
        if (/updateProduct\s*\([^)]*\)\s*\{/.test(q)) {
          send(res, 200, {
            errors: [
              {
                message:
                  'Field "updateProduct" must not have a selection since type "Boolean" has no subfields.',
              },
            ],
          });
          return;
        }
        const id = Number(variables.id);
        const input = (variables.input ?? {}) as {
          good_id?: number | null;
          status?: boolean;
          current_inventory?: number;
        };
        let found: FakeWebProduct | undefined;
        for (const list of Object.values(state.products)) {
          const p = list.find((x) => x.id === id);
          if (p) {
            found = p;
            break;
          }
        }
        if (!found) {
          send(res, 200, { errors: [{ message: "product not found" }] });
          return;
        }
        if (typeof input.current_inventory === "number")
          found.currentInventory = input.current_inventory;
        if (typeof input.status === "boolean") found.status = input.status;
        if (input.good_id !== undefined) found.goodId = input.good_id;
        send(res, 200, { data: { updateProduct: true } });
        return;
      }

      send(res, 200, { errors: [{ message: `unknown operation ${op}` }] });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    state,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
