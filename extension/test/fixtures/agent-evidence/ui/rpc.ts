import { httpLink, loggerLink, splitLink, unstable_httpBatchStreamLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../router';

function base() {
  return typeof window === 'undefined' ? 'https://example.test' : '';
}

function rpcUrl() {
  return base() + '/api/dispatch';
}

export const api = createTRPCReact<AppRouter>();
export const client = api.createClient({ links: [
  loggerLink(),
  splitLink({
    condition: (operation) => operation.context.stream,
    true: [loggerLink(), unstable_httpBatchStreamLink({ url: rpcUrl() })],
    false: httpLink({ url: rpcUrl() }),
  }),
] });
