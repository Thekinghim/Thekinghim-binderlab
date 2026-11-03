import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** /kontrakt → /avtal (sidan heter Kontrakt, adressen är kvar). Frågan följer med. */
export default async function KontraktRedirect({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  }
  const qs = q.toString();
  redirect(`/avtal${qs ? `?${qs}` : ""}`);
}
