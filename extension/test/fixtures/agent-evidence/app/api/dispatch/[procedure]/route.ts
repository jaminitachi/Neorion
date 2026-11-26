import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { router } from '../../../../router';

const handler = (req: Request) => fetchRequestHandler({ endpoint: '/api/dispatch', router, req });
export { handler as GET, handler as POST };
