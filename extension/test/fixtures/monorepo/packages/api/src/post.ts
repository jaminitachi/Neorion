import { procedure } from "@fixture/trpc";
import type { TRPCRouterRecord } from "@trpc/server";

export const post = {
  all: procedure.query(() => ["first"]),
} satisfies TRPCRouterRecord;
