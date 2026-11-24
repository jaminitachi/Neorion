import { normalize } from '../lib/normalize';
import { procedure, router } from './trpc';
export const appRouter = router({
  create: procedure.input('string').mutation(async (value: string) => normalize(prepareMutation(value))),
});

function prepareMutation(value: string) { return value; }
function exampleContext() { return {}; }
export type ExampleContextShape = ReturnType<typeof exampleContext>;
