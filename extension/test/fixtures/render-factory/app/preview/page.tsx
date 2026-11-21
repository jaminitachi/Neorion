import { useEditor } from "@/ui";

export default function Preview() {
  const editor = useEditor();
  return <editor.Dialog />;
}
