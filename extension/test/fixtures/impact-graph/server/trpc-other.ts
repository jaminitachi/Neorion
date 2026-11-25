import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const separateRouter = t.router({
  invoices: t.router({ total: t.procedure.query(() => 'separate') }),
});
export type SeparateRouter = typeof separateRouter;
