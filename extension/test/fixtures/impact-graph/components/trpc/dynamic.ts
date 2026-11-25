import { createTRPCProxyClient } from '@trpc/client';
import type { SeparateRouter } from '../../server/trpc-other';

const other = createTRPCProxyClient<SeparateRouter>({ links: [] });
export function useDynamic(name: string) {
  return other.invoices[name].query();
}
