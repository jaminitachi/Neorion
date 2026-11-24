import useSWR, { mutate } from 'swr';
import { parse } from '../lib/normalize';

function onError() { return parse('error'); }
export function useItems() {
  useSWR('/api/items/1', undefined, { onError });
  mutate('/api/items/1');
}
