import { placeholderMetadata, RoutePlaceholder } from "../placeholder";

export const metadata = placeholderMetadata("lager");

export default function Page() {
  return <RoutePlaceholder id="lager" />;
}
