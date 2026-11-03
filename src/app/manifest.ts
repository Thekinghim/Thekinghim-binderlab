import type { MetadataRoute } from "next";

/**
 * Webbappsmanifest (/manifest.webmanifest): Binderlab kan installeras på hemskärmen och
 * öppnas utan webbläsarens ramar. Start i Fyll på (/fyll-pa, mobilsidan vid automaten);
 * fältsidorna (Fyll på, påfyllning, besöksplan) fungerar utan uppkoppling (public/sw.js). Ikonen är src/app/icon.svg; PNG-ikonerna i
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
    start_url: "/fyll-pa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
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
