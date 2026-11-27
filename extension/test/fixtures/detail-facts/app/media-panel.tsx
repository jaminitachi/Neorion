'use client';

import { useEffect as watchEffect, useState as localState } from 'react';
import { MediaDialog } from './media-dialog';
import { NativeUploader, ImmediateUploader } from './uploaders';

export function MediaPanel() {
  const [active, setActive] = localState<{ slug: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = localState(false);
  const [revision, setRevision] = localState(0);

  function refreshLibrary() {
    return fetch('/api/media');
  }
  watchEffect(() => { refreshLibrary(); }, [revision]);

  const pickAsset = () => {
    setActive({ slug: 'picked' });
    setDrawerOpen(true);
  };
  function saveFinished() {
    setRevision(value => value + 1);
  }
  function closeDialog() {
    setDrawerOpen(false);
  }
  function shadowed(setDrawerOpen: (x: boolean) => void) {
    setDrawerOpen(false);
  }
  return <>
    <button onClick={pickAsset}>Pick asset</button>
    {active && <MediaDialog open={drawerOpen} slug={active.slug} onSuccess={saveFinished} onDismiss={closeDialog} />}
    <NativeUploader />
    <ImmediateUploader />
  </>;
}
