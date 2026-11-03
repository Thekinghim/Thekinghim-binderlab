import { redirect } from "next/navigation";

/**
 * Tillfällig: huvudfliken "Vårt lager" pekar hit, men sidan byggs på annat håll. Tills
 * den riktiga sidan ersätter den här filen visas lagret i Prognos (blocket "Vårt lager").
 */
export default function OurStockPage(): never {
  redirect("/prognos");
}
