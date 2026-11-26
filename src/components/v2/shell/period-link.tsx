"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, type ComponentProps } from "react";

import { usePeriodHref } from "@/components/shell/use-period";

type Props = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string };

/**
 * Menyns länk som bär periodvalet till periodsidorna (Hem, Pengar, Butiker, Automater,
 * Vårt lager, Lönsamhet), så att I går eller ett eget intervall står kvar när man byter sida.
 * Utan sökparametrar (förrendering): en vanlig länk.
 *
 * Hämtar i förväg först när fingret landar (eller musen kommer över), inte när länken syns:
 * varje periodbyte ger nya adresser, och menyn hämtade annars om alla sidor vid varje byte.
 */
export function PeriodLink(props: Props) {
  return (
    <Suspense fallback={<TouchPrefetchLink {...props} />}>
      <WithPeriod {...props} />
    </Suspense>
  );
}

function WithPeriod({ href, ...rest }: Props) {
  return <TouchPrefetchLink href={usePeriodHref(href)} {...rest} />;
}

function TouchPrefetchLink({ href, onTouchStart, onMouseEnter, ...rest }: Props) {
  const router = useRouter();
  return (
    <Link
      href={href}
      prefetch={false}
      onTouchStart={(e) => {
        router.prefetch(href);
        onTouchStart?.(e);
      }}
      onMouseEnter={(e) => {
        router.prefetch(href);
        onMouseEnter?.(e);
      }}
      {...rest}
    />
  );
}
