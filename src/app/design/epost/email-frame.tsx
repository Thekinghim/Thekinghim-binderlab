"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";

type EmailFrameProps = {
  /** Komplett HTML-dokument */
  html: string;
  /** Visningsbredd i px (600 för skrivbord, 375 för mobil) */
  width: number;
  /** "auto" växer till mejlets höjd. Ett tal ger ett fönster som rullar inuti. */
  height?: number | "auto";
  /** Tillgängligt namn på ramen */
  title: string;
  /** Etikett i ramens list, t.ex. "600 px" */
  label?: string;
  /**
   * Utdrag: visa högst så många px, avklippt efter närmaste hela block i
   * mejlet (aldrig mitt i ett diagram). Iframen tas då ur tabbordningen.
   */
  clip?: number;
  /** Länk till hela mejlet, visas under ett utdrag. */
  moreHref?: string;
  className?: string;
};

/**
 * Mejlet i en iframe med exakt bredd. Är det tillgängliga utrymmet
 * smalare skalas hela ramen ned i stället för att sidan får horisontell
 * rullning. Iframen är sandlådad utan skript.
 */
export function EmailFrame({
  html,
  width,
  height = "auto",
  title,
  label,
  clip,
  moreHref,
  className,
}: EmailFrameProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [contentHeight, setContentHeight] = useState(typeof height === "number" ? height : 960);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 2 px för ramens kanter.
    const measure = () => setScale(Math.min(1, (wrap.clientWidth - 2) / width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [width]);

  const [cut, setCut] = useState<number | null>(null);

  const measureContent = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    if (clip !== undefined) {
      // Mejlets kort är tabellen med radie 6 px; dess rader är hela block.
      const card = [...doc.querySelectorAll("table")].find((t) => t.style.borderRadius === "6px");
      const bottoms = card
        ? [...card.rows].map((r) => Math.round(r.getBoundingClientRect().bottom))
        : [];
      const fit = bottoms.filter((b) => b <= clip);
      setCut(fit.length ? Math.max(...fit) : clip);
      setContentHeight(doc.documentElement.scrollHeight);
      return;
    }
    if (height !== "auto") return;
    setContentHeight(doc.documentElement.scrollHeight);
  }, [height, clip]);

  // srcDoc kan hinna ladda före hydrering, då missas onLoad.
  useEffect(() => {
    if (frameRef.current?.contentDocument?.readyState === "complete") measureContent();
  }, [html, measureContent]);

  const frameHeight =
    clip !== undefined ? contentHeight : typeof height === "number" ? height : contentHeight;
  const shownHeight = clip !== undefined ? (cut ?? clip) : frameHeight;

  return (
    <figure
      className={cn("m-0 flex min-w-0 flex-col gap-2", className)}
      style={{ maxWidth: width + 2 }}
    >
      {label ? (
        <figcaption className="label tnum flex items-center justify-between gap-3 text-subtle">
          <span>{label}</span>
          {scale < 0.995 ? <span>Skala {formatPercent(scale, 0)}</span> : null}
        </figcaption>
      ) : null}
      <div ref={wrapRef} className="w-full">
        <div
          className="relative overflow-hidden rounded-sm border border-line bg-surface"
          style={{ height: Math.ceil(shownHeight * scale) + 2 }}
        >
          <iframe
            ref={frameRef}
            title={title}
            srcDoc={html}
            onLoad={measureContent}
            tabIndex={clip !== undefined ? -1 : undefined}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="block border-0"
            style={{
              width,
              height: frameHeight,
              transform: scale < 1 ? `scale(${scale})` : undefined,
              transformOrigin: "0 0",
            }}
          />
        </div>
        {clip !== undefined && moreHref && cut !== null && cut < contentHeight ? (
          <p className="meta tnum mt-2 flex items-center justify-between gap-3 text-subtle">
            <span>Utdrag, {formatPercent(cut / contentHeight, 0)} av mejlet</span>
            <Link
              href={moreHref}
              className="rounded-xs text-fg underline decoration-line-control underline-offset-4 transition-colors duration-fast ease-instrument hover:decoration-fg"
            >
              Visa hela mejlet
            </Link>
          </p>
        ) : null}
      </div>
    </figure>
  );
}
