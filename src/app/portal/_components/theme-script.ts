/**
 * Portalens tema. Portalen är ljus som standard (butiken visar den gärna för
 * andra), men den som valt mörkt får mörkt. Valet sparas i en cookie (skild från
 * appens val i localStorage), så att servern renderar rätt tema direkt utan blink
 * och utan inline-skript.
 */
export const PORTAL_THEME_COOKIE = "bl_portal_theme";

export type PortalTheme = "light" | "dark";

export function portalTheme(value: string | undefined): PortalTheme {
  return value === "dark" ? "dark" : "light";
}

/** Portalens rotelement (bär data-theme). */
export const PORTAL_ROOT_ID = "portal-root";
