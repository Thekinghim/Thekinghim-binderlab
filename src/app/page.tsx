import { redirect } from "next/navigation";

// Fas 1: inga riktiga skärmar ännu. Startsidan leder till designsystemet.
export default function Home() {
  redirect("/design");
}
