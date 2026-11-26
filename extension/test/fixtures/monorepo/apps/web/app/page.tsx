import type { AppRouter } from "@fixture/api";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { SharedCard } from "@shared/card";

const trpc = createTRPCOptionsProxy<AppRouter>({});

export default function WebPage() {
  const options = trpc.post.all.queryOptions();
  return <SharedCard options={options} />;
}
