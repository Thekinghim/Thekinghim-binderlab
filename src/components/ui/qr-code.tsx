import { encodeQr, qrPath, type QrLevel } from "@/lib/qr";

/**
 * QR-kod som SVG (src/lib/qr.ts). Svart på vitt med fyra modulers marginal i båda
 * färgtemana, så att den alltid går att skanna.
 */
export function QrCode({
  value,
  label,
  level = "M",
  className,
}: {
  value: string;
  /** Tillgänglig text, t.ex. "QR-kod för koden K7Q2". */
  label: string;
  level?: QrLevel;
  className?: string;
}) {
  const m = encodeQr(value, { level });
  const side = m.size + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={qrPath(m, 4)} fill="#000" />
    </svg>
  );
}
