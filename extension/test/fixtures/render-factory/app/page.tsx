import { useEditor } from "@/ui";

export default function Page() {
  const { Dialog: RenderDialog } = useEditor();
  return <RenderDialog />;
}
