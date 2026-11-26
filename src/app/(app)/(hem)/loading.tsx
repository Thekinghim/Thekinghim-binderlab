import { V2PageSkeleton } from "@/components/v2/skeleton";

/**
 * Medan Hem hämtar: rubriken, raden under, periodvalet och korten som skeleton direkt vid
 * trycket på fliken (i stället för att den förra sidan står kvar). Egen ruttgrupp, så att
 * skelettet bara gäller Hem och inte alla sidor under (app).
 */
export default function HemLoading() {
  return <V2PageSkeleton label="Laddar hem" sub period main={[5, 4, 5]} />;
}
