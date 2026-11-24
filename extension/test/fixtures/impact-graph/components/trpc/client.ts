import { createTRPCReact as createReactProxy } from '@trpc/react-query';
import { createTRPCClient } from '@trpc/client';
import type { BillingRouter } from '../../server/trpc-routes';

export const service = createReactProxy<BillingRouter>();
export const plainClient = createTRPCClient<BillingRouter>({ links: [] });
