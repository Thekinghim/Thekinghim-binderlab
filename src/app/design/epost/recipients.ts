import type { RecipientKind } from "@/emails/report-content";

/** Vad varje mottagare får, och vad som medvetet lämnas bort. */
export const recipientNotes: Record<RecipientKind, { who: string; gets: string; omits: string }> = {
  butik: {
    who: "Centrumledningen där automaten står",
    gets: "Försäljning som underlag för provisionen, sålda pack, drifttid, avbrott med orsak och nästa servicebesök.",
    omits: "Marginal, kostnader och andra platser.",
  },
  bokforing: {
    who: "Bokhållaren",
    gets: "Försäljning, provision, hyra och inköp på konton med verifikationsnummer, och bilagor med underlag.",
    omits: "Förändring mot föregående månad och planer.",
  },
  delagare: {
    who: "Delägaren",
    gets: "Intäkt, vinst, marginal mot mål, kassaflöde, de tre automaterna och planen för nästa månad.",
    omits: "Enskilda transaktioner och verifikationer.",
  },
};
