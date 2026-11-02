import { placeholderMetadata, RoutePlaceholder } from "../placeholder";

export const metadata = placeholderMetadata("expansion");

export default function Page() {
  return <RoutePlaceholder id="expansion" />;
}
