import type { MetadataRoute } from "next";

/**
 * Webbappsmanifest (/manifest.webmanifest): Binderlab kan installeras på hemskärmen och
 * öppnas utan webbläsarens ramar. Start i Drift, där fältsidorna (påfyllning, besöksplan)
 * fungerar utan uppkoppling (public/sw.js). Ikonen är src/app/icon.svg.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Binderlab",
    short_name: "Binderlab",
    description: "Kontrollpanel för varuautomater med samlarkort.",
    lang: "sv",
    dir: "ltr",
    start_url: "/drift",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
    shortcuts: [
      { name: "Registrera påfyllning", short_name: "Påfyllning", url: "/drift/pafyllning" },
      { name: "Besöksplan", short_name: "Besök", url: "/drift/besok" },
      { name: "Maskinhälsa", short_name: "Drift", url: "/drift" },
    ],
  };
}
