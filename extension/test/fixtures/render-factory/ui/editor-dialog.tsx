import { useCallback as stable, useMemo } from "react";
import { Editor } from "./editor";

function EditorDialog() {
  return <Editor />;
}

export function useEditor() {
  const DialogCallback = stable(() => <EditorDialog />, []);
  const UnusedCallback = stable(() => <EditorDialog />, []);
  return useMemo(() => ({ Dialog: DialogCallback, UnusedCallback }), [DialogCallback, UnusedCallback]);
}
