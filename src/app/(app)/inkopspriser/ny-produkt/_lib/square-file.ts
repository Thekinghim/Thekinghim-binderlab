import { fitInSquare, SQUARE_SIDE } from "./square";

/**
 * Lägger bilden mitt i en kvadrat (600×600, genomskinlig kant) som png. Awish gör alltid om
 * bilden till en kvadrat, så en avlång bild blev utdragen; nu behåller den sina proportioner.
 */
export async function squareImage(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const box = fitInSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = SQUARE_SIDE;
    canvas.height = SQUARE_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, box.x, box.y, box.w, box.h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".png", { type: "image/png" });
  } catch {
    return file;
  }
}
