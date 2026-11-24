import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

function countFeed() { return 5; }

const feedRouter = t.router({
  feed: {
    count: t.procedure.query(countFeed),
    nested: { deep: { item: t.procedure.query(() => 'item') } },
  },
});
const adminRouter = t.router({
  admin: {
    stats: t.procedure.query(() => 'stats'),
    update: t.procedure.mutation(() => true),
  },
});
export const reviewRouter = t.mergeRouters(feedRouter, adminRouter);
export type ReviewRouter = typeof reviewRouter;

function makeQuery() { return t.procedure.query(() => []); }
export const helperRouter = t.router({
  helper: { built: makeQuery(), direct: t.procedure.query(() => []) },
});
export type HelperRouter = typeof helperRouter;

export const opaqueBatchRouter = t.router({ batch: { item: t.procedure.query(() => 'item') } });
export type OpaqueBatchRouter = typeof opaqueBatchRouter;

export const dynamicOptionsRouter = t.router({ options: { item: t.procedure.query(() => 'item') } });
export type DynamicOptionsRouter = typeof dynamicOptionsRouter;
