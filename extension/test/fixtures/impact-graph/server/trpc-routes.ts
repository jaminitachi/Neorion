import * as server from '@trpc/server';

const t = server.initTRPC.context().create();
const createTRPCRouter = t.router;
const protectedProcedure = t.procedure.use(() => {});
export const createCallerFactory = t.createCallerFactory;

function calculateTotal() { return 42; }
function storeInvoice() { return calculateTotal(); }

const invoiceRouter = createTRPCRouter({
  total: protectedProcedure.input('number').query(() => calculateTotal()),
  create: protectedProcedure.mutation(storeInvoice),
  list: protectedProcedure.query(() => []),
  changed: protectedProcedure.subscription(() => {}),
});

export const billingRouter = t.router({
  invoices: invoiceRouter,
  history: invoiceRouter,
});
export type BillingRouter = typeof billingRouter;
export const createCaller = createCallerFactory(billingRouter);
