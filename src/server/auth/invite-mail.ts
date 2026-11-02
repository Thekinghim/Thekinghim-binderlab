/** Inbjudningsmejlets text (dev-brevlådan). Supabase använder sin egen mall. */
export function inviteMail(acceptUrl: string): { subject: string; text: string } {
  return {
    subject: "Du är inbjuden till Binderlab",
    text: [
      "Hej!",
      "",
      "Du har blivit inbjuden till Binderlab. Öppna länken för att gå med:",
      "",
      acceptUrl,
      "",
      "Länken gäller i 7 dagar och kan bara användas en gång.",
      "Om du inte väntade dig det här mejlet kan du bortse från det.",
    ].join("\n"),
  };
}
