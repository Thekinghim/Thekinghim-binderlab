/**
 * Portalens tema. Portalen är ljus som standard (butiken visar den gärna för
 * andra), men den som valt mörkt får mörkt. Valet sparas separat från appens
 * (binderlab-portal-theme) och sätts på <html>, så att dialoger och notiser
 * följer med. När portalen lämnas återställs appens val (PortalThemeScope).
 */
export const PORTAL_THEME_KEY = "binderlab-portal-theme";

/** Sätts inline i portalens layout så att första målningen får rätt tema. */
export const portalThemeScript = `(function(){try{var t=localStorage.getItem("${PORTAL_THEME_KEY}");document.documentElement.dataset.theme=(t==="dark"?"dark":"light")}catch(e){document.documentElement.dataset.theme="light"}})();`;
