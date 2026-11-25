declare module '@trpc/react-query' { export function createTRPCReact<T>(): any; }
declare module '@trpc/react-query/rsc' {
  export function createHydrationHelpers<T>(caller: unknown, getQueryClient: unknown): { trpc: any; HydrateClient: any };
}
declare module '@trpc/tanstack-react-query' {
  export function createTRPCContext<T>(): { useTRPC: () => any; useTRPCClient: () => any; TRPCProvider: any };
}
declare module '@trpc/client' {
  export function createTRPCClient<T>(options: unknown): any;
  export function createTRPCProxyClient<T>(options: unknown): any;
}
