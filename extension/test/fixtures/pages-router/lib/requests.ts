import axios from 'axios';
import { createTRPCProxyClient, httpBatchLink as batch } from '@trpc/client';

const requester = axios.create({ baseURL: '/base' });
const alias = requester;
function send(path: string) { return alias.post(path); }

const client = createTRPCProxyClient({ links: [batch({ url: '/api/auth' })] });

export function requests() {
  send('/api/table');
  client.accounts.details.query();
  const mutation = client.accounts.update.useMutation();
  mutation.mutate({});
  return fetch('/base/api/auth/signup', { method: 'POST' });
}

export function shadow(requester) { requester.post('/api/auth/shadow'); }
