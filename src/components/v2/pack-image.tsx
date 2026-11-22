import Image from "next/image";

import { cn } from "@/lib/cn";
import { PACK_IMAGES, packInitials, packKey } from "@/lib/pack-image";

/** Höjder som i prototypen: xs 22, m 40, md 54 (standard), l 60, xl 72 px. */
const HEIGHT = { xs: 22, m: 40, md: 54, l: 60, xl: 72 } as const;
export type PackSize = keyof typeof HEIGHT;

/** Packens format (bredd ÷ höjd) för plattan utan bild: samma som de flesta bilderna. */
const PLACEHOLDER_ASPECT = 131 / 240;

/**
 * Packbilden för en titel (public/packs, via packKey). Dekor: titeln står alltid bredvid, så
 * bilden har tom alt-text. Ingen bild för titeln = en neutral platta i samma format med två
 * bokstäver (namnet som tooltip), eller inget alls med `placeholder={false}`.
 */
export function PackImage({
  title,
  size = "md",
  className,
  priority = false,
  placeholder = true,
}: {
  title: string | null | undefined;
  size?: PackSize;
  className?: string;
  priority?: boolean;
  placeholder?: boolean;
}) {
  const key = packKey(title);
  const height = HEIGHT[size];
  if (!key) {
    if (!placeholder || !title?.trim()) return null;
    const width = Math.round(PLACEHOLDER_ASPECT * height);
    return (
      <span
        aria-hidden="true"
        title={title}
        className={cn("v2-pk v2-pk-none", className)}
        style={{ height, width, fontSize: Math.max(8, Math.round(height / 4.5)) }}
      >
        {size === "xs" ? null : packInitials(title)}
      </span>
    );
  }
  const [w, h] = PACK_IMAGES[key];
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
