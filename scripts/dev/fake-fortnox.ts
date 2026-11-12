/**
 * Låtsas-Fortnox för lokal utveckling (aldrig riktiga Fortnox):
 *
 *   npx tsx scripts/dev/fake-fortnox.ts              # lyssnar på 127.0.0.1:4610
 *
 * och i .env.local:
 *
 *   FORTNOX_CLIENT_ID=fake-client-id
 *   FORTNOX_CLIENT_SECRET=fake-client-secret
 *   FORTNOX_API_BASE_URL=http://127.0.0.1:4610
 *   FORTNOX_AUTH_BASE_URL=http://127.0.0.1:4610
 *   FORTNOX_REDIRECT_URI=http://localhost:3200/datakallor/fortnox/klar
 *
 * Koppla sedan under Datakällor → Fortnox: låtsas-Fortnox godkänner direkt och skickar
 * tillbaka dig. Verifikaten syns på http://127.0.0.1:4610/__fake/state. Den nekar låst
 * period, okända konton och obalans som riktiga Fortnox (se
 * src/server/fortnox/testing/fake-fortnox.ts). Allt ligger i minnet.
 */

import { FakeFortnox } from "../../src/server/fortnox/testing/fake-fortnox";

const port = Number(process.env.FAKE_FORTNOX_PORT ?? 4610);

async function main(): Promise<void> {
  const fake = new FakeFortnox();
  const url = await fake.start(port);
  console.log(`Låtsas-Fortnox lyssnar på ${url} (verifikat: ${url}/__fake/state)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
