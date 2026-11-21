import Image from "next/image";

import { cn } from "@/lib/cn";
import { PACK_IMAGES, packKey } from "@/lib/pack-image";

/** Höjder som i prototypen: xs 22, m 40, md 54 (standard), l 60, xl 72 px. */
const HEIGHT = { xs: 22, m: 40, md: 54, l: 60, xl: 72 } as const;
export type PackSize = keyof typeof HEIGHT;

/**
 * Packbilden för en titel (public/packs, via packKey). Dekor: titeln står alltid bredvid, så
 * bilden har tom alt-text. Ingen bild för titeln = inget ritas (null).
 */
export function PackImage({
  title,
  size = "md",
  className,
  priority = false,
}: {
  title: string | null | undefined;
  size?: PackSize;
  className?: string;
  priority?: boolean;
}) {
  const key = packKey(title);
  if (!key) return null;
  const [w, h] = PACK_IMAGES[key];
  const height = HEIGHT[size];
  const width = Math.round((w / h) * height);
  return (
    <Image
      src={`/packs/${key}.webp`}
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      className={cn("v2-pk", size === "l" && "l", size === "xl" && "xl", className)}
      style={{ height, width }}
      priority={priority}
      // Bilderna är redan små webp i rätt storlek (240 px höga): ingen omräkning behövs.
      unoptimized
      draggable={false}
    />
  );
}

/** Små packbilder med namn ("▮ Prismatic Evolutions ▮ Black Bolt"). */
export function PackList({ titles, label }: { titles: readonly string[]; label?: string }) {
  return (
    <span className="inline-flex items-start gap-2.5 align-middle">
      {label ? <span className="flex-none leading-[26px]">{label}</span> : null}
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {titles.map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <PackImage title={t} size="xs" />
            {t}
          </span>
        ))}
      </span>
    </span>
  );
}
