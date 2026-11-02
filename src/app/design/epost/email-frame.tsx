"use client";

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

  const measureContent = useCallback(() => {
    if (height !== "auto") return;
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement) setContentHeight(doc.documentElement.scrollHeight);
  }, [height]);

  // srcDoc kan hinna ladda före hydrering, då missas onLoad.
  useEffect(() => {
    if (frameRef.current?.contentDocument?.readyState === "complete") measureContent();
  }, [html, measureContent]);

  const frameHeight = typeof height === "number" ? height : contentHeight;

  return (
    <figure className={cn("m-0 flex min-w-0 flex-col gap-2", className)} style={{ maxWidth: width + 2 }}>
      {label ? (
        <figcaption className="label tnum flex items-center justify-between gap-3 text-subtle">
          <span>{label}</span>
          {scale < 1 ? <span>Skala {formatPercent(scale, 0)}</span> : null}
        </figcaption>
      ) : null}
      <div ref={wrapRef} className="w-full">
        <div
          className="overflow-hidden rounded-sm border border-line bg-surface"
          style={{ height: Math.ceil(frameHeight * scale) + 2 }}
        >
          <iframe
            ref={frameRef}
            title={title}
            srcDoc={html}
            onLoad={measureContent}
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
      </div>
    </figure>
  );
}
