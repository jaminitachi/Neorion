import { router } from "@fixture/trpc";
import { post } from "./post";

export const appRouter = router({ post });
export type AppRouter = typeof appRouter;
