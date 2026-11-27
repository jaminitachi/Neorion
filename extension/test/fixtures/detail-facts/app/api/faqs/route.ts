import { store } from '../../../lib/prisma';

declare function addVisibility(value: object): void;

export async function GET() {
  const whereClause: Record<string, unknown> = { status: 'PUBLISHED' };
  whereClause.OR = [{ visibility: 'PUBLIC' }];
  await store.faq.findMany({ where: whereClause });

  const assigned = { status: 'PUBLISHED' };
  Object.assign(assigned, { OR: [{ visibility: 'PUBLIC' }] });
  await store.faq.count({ where: assigned });

  const escaped = { status: 'PUBLISHED' };
  const args = { where: escaped };
  addVisibility({ where: escaped });
  await store.faq.aggregate(args);

  const unchanged = { status: 'PUBLISHED' };
  {
    const unchanged: Record<string, unknown> = {};
    unchanged.OR = [];
  }
  await store.faq.findFirst({ where: unchanged });
  addVisibility(unchanged);
  return Response.json({ done: true });
}

declare const db: any;
export async function POST() {
  await db.select().from('faq').where('published').limit(5);
  return Response.json({ ok: true });
}
