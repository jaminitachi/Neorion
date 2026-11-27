import { store } from '../../../../lib/prisma';

export async function GET(request: Request) {
  const category = new URL(request.url).searchParams.get('category');
  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  const args = { where, orderBy: { name: 'asc' } };
  return Response.json(await store.fileType.findMany(args));
}
