import { useState } from 'react';
import { useDropzone } from 'react-dropzone';

export function NativeUploader() {
  const [jobs, setJobs] = useState<{ source: File; status: string }[]>([]);
  const enqueue = (files: File[]) => {
    const items = files.map(source => ({ source, status: 'waiting' }));
    setJobs(previous => [...previous, ...items]);
  };
  useDropzone({ onDrop: enqueue });
  const send = (source: File) => {
    const payload = new FormData();
    payload.append('source', source);
    const transport = new XMLHttpRequest();
    transport.open('PUT', '/api/imports');
    transport.send(payload);
  };
  const flush = () => {
    for (const job of jobs.filter(job => job.status === 'waiting')) send(job.source);
  };
  return <button onClick={flush}>Send jobs</button>;
}

export function ImmediateUploader({ directory }: { directory?: string }) {
  const [busy, setBusy] = useState(false);
  async function send(files: File[]) {
    for (const file of files) {
      const payload = new FormData();
      payload.append('source', file);
      if (directory) payload.append('directory', directory);
      await fetch('/api/imports', { method: 'PUT', body: payload });
    }
    const method = directory ? 'HEAD' : 'GET';
    await fetch('/api/imports', { method });
  }
  const receive = (files: File[]) => {
    setBusy(true);
    send(files);
  };
  useDropzone({ onDrop: receive });
  return <section />;
}
