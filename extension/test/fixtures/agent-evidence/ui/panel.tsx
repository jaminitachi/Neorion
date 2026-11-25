'use client';

import { useCallback } from 'react';
import { sendResource } from '../app/actions';
import { api } from './rpc';

function useSender() {
  const send = useCallback((file: File) => sendResource(file), []);
  return { send };
}

function Picker({ onPick }) {
  const select = (event) => {
    const file = event.target.files?.[0];
    if (file) onPick(file);
  };
  return <input type="file" onChange={select} />;
}

export function ResourceRow() {
  return <li>Resource</li>;
}

export function ResourcePanel({ items }) {
  const { send: upload } = useSender();
  const { mutate: publish } = api.resources.store.useMutation();
  const markdownPick = (event) => upload(event.target.files[0]);
  const submit = (published) => publish({ title: items[0]?.title, kind: 'RESOURCE', published, password: 'should-stay-private' });
  const usePicker = items.length > 1;
  return <section>
    {usePicker ? <Picker onPick={upload} /> : <input type="file" onChange={markdownPick} />}
    <button onClick={() => submit(true)}>Publish</button>
    {items.length > 0 && items.map(item => <div>{item.visible ? <ResourceRow /> : null}</div>)}
  </section>;
}
