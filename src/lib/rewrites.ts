/**
 * Adresser som visar en annan sidas rutt utan att adressen ändras, i next.config.ts
 * (rewrites(), före filsystemet). Testas i rewrites.test.ts.
 *
 * /fyll-pa/<automat> visar samma rutt som /fyll-pa. Fyll på byter mellan listan och en automat
 * i webbläsaren (history.pushState), utan att hämta något, så att det går fort och fungerar
 * utan nät. Var det två olika rutter i Next hörde adressen ibland till en annan rutt än den
 * sidan var renderad för. När en påfyllning sparades (servern räknar om sidan) svarade
 * servern då med en annan rutt än webbläsaren hade, och Next försökte om, monterade om Fyll
 * på och laddade ibland om hela sidan: bekräftelsen "Klart! N pack påfyllda" syntes aldrig.
 * Med en gemensam rutt finns inget att bli oense om. Automaten läses ur adressen
 * (src/app/fyll-pa/page.tsx på servern, FillApp i webbläsaren).
 *
 * Rutten src/app/fyll-pa/[machineId]/page.tsx finns kvar för adresser som inte är ett id
 * (/fyll-pa/abc visar listan) och om omskrivningen av något skäl inte skulle gälla.
 */
export const APP_REWRITES: ReadonlyArray<{
  readonly source: string;
  readonly destination: string;
}> = [
  // Ett uuid och inget efter (/fyll-pa/<id>/qr är en egen sida).
  { source: "/fyll-pa/:machineId([0-9a-fA-F-]{36})", destination: "/fyll-pa" },
];
