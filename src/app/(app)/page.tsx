import { placeholderMetadata, RoutePlaceholder } from "./placeholder";

export const metadata = placeholderMetadata("hem");

export default function Page() {
  return <RoutePlaceholder id="hem" />;
}
