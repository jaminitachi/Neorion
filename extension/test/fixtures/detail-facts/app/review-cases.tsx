import { useCallback, useEffect, useMemo, useState } from 'react';

import { executeAsync } from '../lib/edit-request';
declare function addDraft(payload: object): void;
declare const Button: (props: Record<string, unknown>) => JSX.Element;

export function RequestFolderEditAccessButton({ isRequested }: { isRequested: boolean }) {
  const [requestSent, setRequestSent] = useState(false);
  function finished() { setRequestSent(true); }
  return <Button
    disabled={isRequested || requestSent}
    text={isRequested ? 'Requested' : requestSent ? 'Sent' : 'Request edit access'}
    visible={!requestSent}
    pending={false === requestSent}
    onClick={async () => await executeAsync()}
    onTouchStart={requestSent ? finished : setRequestSent}
  />;
}

export function EditApprovalButton() {
  const [isApproved] = useState(false);
  return <Button onClick={executeAsync} disabled={isApproved} />;
}

export function DownloadProgress({ teamId, jobId }: { teamId: string; jobId: string }) {
  const [status, setStatus] = useState('queued');
  const fetchStatus = () => fetch(`/api/teams/${teamId}/downloads/${jobId}`);
  const fetchStatic = () => fetch('/api/teams/sample/documents/example/views/v1/stats?format=short');
  return <button data-status={status}
    onClick={() => { fetchStatus(); fetchStatic(); setStatus('loading'); }}>{status}</button>;
}

export function EditDialog({ itemId }: { itemId: string }) {
  const [value, setValue] = useState('');
  const save = () => {
    const inline: Record<string, unknown> = {};
    inline.value = value;
    fetch(`/api/admin/users/${itemId}`, { method: 'PATCH', body: JSON.stringify(inline) });

    const escaped = { value };
    addDraft(escaped);
    fetch(`/api/admin/users/${itemId}`, { method: 'PATCH', body: JSON.stringify(escaped) });
  };
  return <Button onClick={save} onChange={setValue} />;
}

export function PreviewSettings({ open, fileId }: { open: boolean; fileId: string }) {
  const [fileUrl, setFileUrl] = useState('');
  const [locked, setLocked] = useState(true);
  useEffect(() => {
    const url = '/files/' + fileId;
    setFileUrl(url);
  }, [open, fileId]);
  function unlock() {
    window.confirm('Unlock?') && setLocked(false);
    if (open) setLocked(true);
  }
  return <Button onClick={unlock} href={fileUrl} locked={locked} />;
}

function LinkedDownload({ url }: { url: string }) {
  const [loading, setLoading] = useState(false);
  function download() {
    fetch(url);
    setLoading(true);
  }
  return <button disabled={loading} onClick={download}>Download</button>;
}

export function DownloadLinks() {
  return <>
    <LinkedDownload url="/api/teams/example/downloads/first" />
    <LinkedDownload url="/api/teams/example/downloads/second" />
  </>;
}

declare const ArchiveLinkModal: typeof Button;
declare const ModalContext: { Provider: typeof Button };

export function useArchiveLinkModal() {
  const [showArchiveLinkModal, setShowArchiveLinkModal] = useState(false);
  const ArchiveLinkModalCallback = useCallback(() => (
    <ArchiveLinkModal open={showArchiveLinkModal} setOpen={setShowArchiveLinkModal} />
  ), [showArchiveLinkModal]);
  return useMemo(() => ({ setShowArchiveLinkModal, ArchiveLinkModal: ArchiveLinkModalCallback }), [ArchiveLinkModalCallback]);
}

export function useReturnedSetter() {
  const [open, setOpen] = useState(false);
  return [open, setOpen];
}

export function useReturnedCallback() {
  const [open, setOpen] = useState(false);
  return () => setOpen(true);
}

export function ModalProvider() {
  const [open, setOpen] = useState(false);
  return <ModalContext.Provider value={{ open, setOpen }} />;
}

export function useContextSetter() {
  const [open, setOpen] = useState(false);
  registerSetter(setOpen);
}
declare function registerSetter(setter: (value: boolean) => void): void;

export function useLocalState() {
  const [open, setOpen] = useState(false);
  setOpen(true);
}

export function MaintenanceChecker({ pathname }: { pathname: string }) {
  function checkMaintenance() {
    return fetch('/api/maintenance/check');
  }
  useEffect(() => {
    if (pathname === '/maintenance') return;
    checkMaintenance();
  }, [pathname]);
  return null;
}

export function PreviewPagesViewer() {
  const [busy, setBusy] = useState(false);
  const pagesApiEndpoint = '/api/teams/sample/documents/example/preview-pages';
  function ensurePagesLoaded() {
    fetch(pagesApiEndpoint, { method: 'POST' });
    setBusy(true);
  }
  return <button onClick={ensurePagesLoaded} disabled={busy} />;
}
