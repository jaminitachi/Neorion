import { vitePlugin as remix } from '@remix-run/dev';
export default { plugins: [remix({ appDirectory: 'web', ignoredRouteFiles: ['**/helper.*'] })] };
