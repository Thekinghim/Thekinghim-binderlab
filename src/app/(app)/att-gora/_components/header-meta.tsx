import type { HeaderView } from "../_lib/model";

/**
 * Metadatan i sidhuvudet. Från lg som SectionHeaders rader (etikett till vänster, värde
 * till höger); under lg på en rad som bryts, så att första punkten syns utan att skrolla
 * på mobilen.
 */
export function HeaderMeta({ items }: { items: HeaderView["meta"] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 border-y border-line py-2 text-left lg:flex-col lg:gap-0 lg:border-b-0 lg:py-0">
      {items.map((m) => (
        <div
          key={m.label}
          className="flex items-baseline gap-2 lg:justify-between lg:gap-4 lg:border-b lg:border-line lg:py-1.5"
        >
          <dt className="label shrink-0 text-subtle">{m.label}</dt>
          <dd className="meta tnum min-w-0 truncate text-fg lg:text-right">{m.value}</dd>
        </div>
      ))}
    </dl>
  );
}
