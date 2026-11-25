import { createTRPCReact } from '@trpc/react-query';
import { createHydrationHelpers } from '@trpc/react-query/rsc';
import { useReview, useReviewClient } from '../../components/trpc/review-context';
import { reviewRouter, type ReviewRouter } from '../../server/trpc-review';

const classic = createTRPCReact<ReviewRouter>();
const { trpc: server } = createHydrationHelpers<ReviewRouter>(reviewRouter.createCaller({}), () => ({}));

export function useClassicBatch() {
  classic.useQueries(q => [q.feed.count(), q.admin.stats()]);
  classic.useSuspenseQueries(q => {
    return [q.feed.nested.deep.item()];
  });
}

export function useReactQueryOptions() {
  const trpc = useReview();
  const { queryOptions } = trpc.admin.stats;
  queryOptions();
  trpc.admin.update.mutationOptions();
  trpc.feed.count.queryKey();
  trpc.feed.pathFilter();
  useReviewClient().admin.stats.query();
}

export function unrelatedBatch(classic: any) {
  classic.useQueries(q => [q.feed.count()]);
  classic.useSuspenseQueries(q => [q.admin.stats()]);
}

interface Counter { getRemoteCount(): number }
export function readContract(counter: Counter) { return counter.getRemoteCount(); }

export default async function TrpcReviewPage() {
  await server.feed.count();
  void server.feed.nested.deep.item.prefetch();
  return null;
}
