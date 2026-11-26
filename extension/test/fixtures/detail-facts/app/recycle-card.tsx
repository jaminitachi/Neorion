export function RecycleCard({ file, onRestore }: {
  file: { id: string; name: string };
  onRestore: (id: string, name: string) => void;
}) {
  function handleRestore() {
    onRestore(file.id, file.name);
  }
  return <button onClick={handleRestore}>Restore</button>;
}
