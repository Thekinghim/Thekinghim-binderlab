import type { MetadataRoute } from "next";

/**
 * Webbappsmanifest (/manifest.webmanifest): Binderlab kan installeras på hemskärmen och
 * öppnas utan webbläsarens ramar. Start på / (Hem; påfyllare och butiker skickas vidare till
 * sin egen sida av inloggningen och layouten). Färgerna är V2:s ljusa bakgrund (--v2-bg), så att
 * startskärmen och statusraden har samma grå som appen. Fältsidorna (Fyll på, påfyllning, besöksplan) fungerar utan uppkoppling (public/sw.js). Ikonen är src/app/icon.svg; PNG-ikonerna i
 * public/icons är renderade ur den (192, 512 och en maskerbar 512).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Binderlab",
    short_name: "Binderlab",
    description: "Kontrollpanel för varuautomater med samlarkort.",
    lang: "sv",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f1f1f1",
    theme_color: "#f1f1f1",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
      // Android kräver PNG i 192 och 512 px; den maskerbara har marginal för rundade masker.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Fyll på", short_name: "Fyll på", url: "/fyll-pa" },
      { name: "Besöksplan", short_name: "Besök", url: "/drift/besok" },
      { name: "Maskinhälsa", short_name: "Drift", url: "/drift" },
    ],
  };
}
