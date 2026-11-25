import { createTRPCContext as createContext } from '@trpc/tanstack-react-query';
import type { DynamicOptionsRouter, ReviewRouter } from '../../server/trpc-review';

const context = createContext<ReviewRouter>();
export const { useTRPC: useReview, useTRPCClient: useReviewClient } = context;
export const dynamicContext = createContext<DynamicOptionsRouter>();
