/**
 * Adresser som bara pekar vidare, i next.config.ts (redirects()). De skickas vidare av
 * Next/Vercel innan sidan renderas, så de kostar ingen egen serverrendering och inloggning
 * (en sida med redirect() lade ett helt varv till: /kontrakt 3,7 s mot /avtal 3,2 s).
 * Frågan (?vy=…, ?skapa=…) följer med. Testas i redirects.test.ts.
 */
export const APP_REDIRECTS: ReadonlyArray<{
  readonly source: string;
  readonly destination: string;
  readonly permanent: boolean;
}> = [
  // Sidan heter Kontrakt men ligger på /avtal (menyn länkar dit direkt).
  { source: "/kontrakt", destination: "/avtal", permanent: false },
  // Bokföringen är en flik på Ekonomi (gamla länkar och bokmärken).
  { source: "/ekonomi/bokforing", destination: "/ekonomi?vy=bokforing", permanent: false },
  // V2: Rutt (skrivfel och gamla bokmärken).
  { source: "/rutten", destination: "/rutt", permanent: false },
  { source: "/route", destination: "/rutt", permanent: false },
  // V2: Rutt visar besöksplanen (docs/design/v2/byggplan.md avsnitt 1.3). Kalenderfilen
  // /drift/besok/kalender ligger kvar orörd (source matchar bara exakt /drift/besok).
  { source: "/drift/besok", destination: "/rutt", permanent: false },
];
