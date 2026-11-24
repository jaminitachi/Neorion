'use server';
import { revalidatePath as revalidate } from 'next/cache';
import { normalize } from '../lib/normalize';
import { db } from './db';

export async function createItem(value: string) {
  const label = normalize(value);
  await db.$transaction(tx => tx.item.create({ data: { label } }));
  revalidate('/items');
  normalize(label);
  normalize(label);
  normalize(label);
}

export async function anotherAction() { return 'different owner'; }
export { createItem as submitItem };
