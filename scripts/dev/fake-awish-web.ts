/**
 * Låtsas-Awish webbpanel för lokal utveckling (aldrig riktiga Awish):
 *
 *   npx tsx scripts/dev/fake-awish-web.ts            # lyssnar på 127.0.0.1:4555
 *   AWISH_WEB_BASE_URL=http://127.0.0.1:4555 next dev --webpack
 *
 * Spara sedan inloggningen butik@example.com / hemligt under Datakällor → Awish och koppla
 * en automat till Awish-id 1001. Låtsas-panelen nekar anrop med fel form, precis som
 * riktiga Awish (se src/server/awish/testing/fake-web-server.ts). Allt ligger i minnet.
 */

import { startFakeAwishWeb } from "../../src/server/awish/testing/fake-web-server";

const port = Number(process.env.FAKE_AWISH_PORT ?? 4555);

async function main(): Promise<void> {
  const fake = await startFakeAwishWeb(
    {
      products: {
        "1001": [
          {
            id: 11,
            goodId: 6,
            goodName: "Mystery Pack",
            status: true,
            currentInventory: 5,
            capacity: 10,
            channelName: "A1",
          },
          {
            id: 12,
            goodId: 7,
            goodName: "30th Celebration",
            status: true,
            currentInventory: 2,
            capacity: 10,
            channelName: "A2",
          },
          {
            id: 13,
            goodId: null,
            goodName: null,
            status: true,
            currentInventory: 0,
            capacity: 8,
            channelName: "A3",
          },
        ],
      },
    },
    { port },
  );

  console.log(`Låtsas-Awish på ${fake.baseUrl} (inloggning ${fake.state.email})`);
  process.on("SIGINT", () => {
    console.log(
      JSON.stringify(
        { calls: fake.state.calls.map((c) => c.operationName), rejected: fake.state.rejected },
        null,
        2,
      ),
    );
    void fake.stop().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
