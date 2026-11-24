'use client';
import { createItem } from '../server/actions';

export function CreateItem() {
  async function onSubmit() { await createItem('item'); }
  return <button onClick={onSubmit}>Create</button>;
}
