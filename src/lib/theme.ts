export type Theme = "dark" | "light";
export const THEME_STORAGE_KEY = "binderlab-theme";

/** Körs inline i <head> före rendering för att undvika blink vid ljust läge. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})();`;
