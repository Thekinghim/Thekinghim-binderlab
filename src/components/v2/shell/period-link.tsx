"use client";

import Link from "next/link";
import { Suspense, type ComponentProps } from "react";

import { usePeriodHref } from "@/components/shell/use-period";

type Props = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

/**
 * Menyns länk som bär periodvalet till periodsidorna (Hem, Pengar, Butiker, Automater,
 * Vårt lager, Lönsamhet), så att I går eller ett eget intervall står kvar när man byter sida.
 * Utan sökparametrar (förrendering): en vanlig länk.
 */
export function PeriodLink(props: Props) {
  return (
    <Suspense fallback={<Link {...props} />}>
      <WithPeriod {...props} />
    </Suspense>
  );
}

function WithPeriod({ href, ...rest }: Props) {
  return <Link href={usePeriodHref(href)} {...rest} />;
}
