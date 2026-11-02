import { PrintSection } from "../../sections/print";

export default function Page() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8">
      <PrintSection index={9} />
    </div>
  );
}
