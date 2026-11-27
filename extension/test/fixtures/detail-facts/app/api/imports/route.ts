import { store } from '../../../lib/prisma';
declare const options: Record<string, unknown>;

export async function PUT() {
  await store.asset.create({ data: { visible: false, ...options } });
  return Response.json({ done: true, ...options });
}

export const GET = () => Response.json({ available: true });
