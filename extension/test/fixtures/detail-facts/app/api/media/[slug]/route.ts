import { NextResponse as Reply } from 'next/server';
import { store } from '../../../../lib/prisma';

export async function PATCH(_request: Request, { params: context }: { params: Promise<{ slug: string }> }) {
  const { slug } = await context;
  const where = { slug };
  const asset = await store.asset.update({ where, data: { archivedOn: null, visible: true } });
  await signalChange(slug);
  return Reply.json({ asset, ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  return Reply.json(await store.asset.delete({ where: { slug } }));
}

declare function signalChange(slug: string): Promise<void>;
