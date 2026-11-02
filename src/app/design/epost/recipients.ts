import type { RecipientKind } from "@/emails/report-content";

/** Vad varje mottagare får, och vad som medvetet lämnas bort. */
export const recipientNotes: Record<RecipientKind, { who: string; gets: string; omits: string }> = {
  butik: {
    who: "Centrumledningen där automaten står",
    gets: "Försäljning inkl. moms som underlag för omsättningshyran, sålda pack, drifttid, avbrott med orsak och nästa servicebesök.",
    omits: "Marginal, kostnader och andra platser.",
  },
  bokforing: {
    who: "Bokhållaren",
    gets: "Försäljning inkl. och exkl. moms, utgående moms, avgifter, konton med verifikationsnummer och bilagor med underlag.",
    omits: "Förändring mot föregående månad och planer.",
  },
  delagare: {
    who: "Delägaren",
    gets: "Intäkt, resultat, marginal mot mål, kassaflöde, de fem största automaterna och planen för nästa månad.",
    omits: "Enskilda transaktioner och verifikationer.",
  },
};
