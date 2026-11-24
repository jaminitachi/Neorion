declare module '@trpc/react-query' { export function createTRPCReact<T>(): any; }
declare module '@trpc/client' {
  export function createTRPCClient<T>(options: unknown): any;
  export function createTRPCProxyClient<T>(options: unknown): any;
}
