import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export function chooseStatus(held: boolean, title: string) {
  if (held) return { status: 'pending_review', title };
  return { status: 'live', title };
}

export function refreshResources() {
  return chooseStatus(false, 'Refresh');
}

export const router = t.router({
  resources: t.router({
    store: t.procedure.mutation(({ input }) => chooseStatus(input.held, input.title))
  })
});
export type AppRouter = typeof router;
