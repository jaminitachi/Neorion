'use client';

import { useRef } from 'react';
import { useJobControls } from '../lib/store';

export function JobBoard({ items }: { items: string[] }) {
  const { capture, start, retry } = useJobControls();
  const elements = useRef(new Map<string, HTMLDivElement>());
  const makeSnapshot = () => capture(items, elements.current);
  return <>
    <button onClick={makeSnapshot}>Snapshot</button>
    <button onClick={start}>Start jobs</button>
    {items.map(key => <button onClick={() => retry(key)}>Retry job</button>)}
    {items.map(key => <div ref={node => {
      if (node) elements.current.set(key, node);
      else elements.current.delete(key);
    }} />)}
  </>;
}
