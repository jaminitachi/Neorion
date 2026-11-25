import { createTRPCReact } from '@trpc/react-query';
import { dynamicContext } from './review-context';
import type { DynamicOptionsRouter, HelperRouter, OpaqueBatchRouter } from '../../server/trpc-review';

const classic = createTRPCReact<OpaqueBatchRouter>();
const helper = createTRPCReact<HelperRouter>();
const mixed = createTRPCReact<DynamicOptionsRouter>();

const getQueries = (q: any) => [q.batch.item()];
export function useOpaqueBatch() { return classic.useQueries(getQueries); }

export function useMixedOptions(name: string) {
  mixed.options.item.useQuery();
  const trpc = dynamicContext.useTRPC();
  trpc.options[name].queryOptions();
}

export function useDynamicKey(name: string) {
  return dynamicContext.useTRPC().options[name].queryKey();
}

export function useHelper() { return helper.helper.built.useQuery(); }
