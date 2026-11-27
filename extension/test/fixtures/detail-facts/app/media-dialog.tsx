import { useState } from 'react';

export function MediaDialog({ open, slug, onSuccess, onDismiss }: {
  open: boolean;
  slug: string;
  onSuccess: () => void;
  onDismiss: () => void;
}) {
  const [retention, setRetention] = useState('3w');
  const save = async () => {
    const response = await fetch(`/api/media/${slug}`, { method: 'PATCH', body: JSON.stringify({ retention }) });
    if (!response.ok) return;
    onSuccess();
  };
  return open ? <><button onClick={save}>Save</button><button onClick={onDismiss}>Cancel</button></> : null;
}
