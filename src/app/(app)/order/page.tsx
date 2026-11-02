import { placeholderMetadata, RoutePlaceholder } from "../placeholder";

export const metadata = placeholderMetadata("order");

export default function Page() {
  return <RoutePlaceholder id="order" />;
}
