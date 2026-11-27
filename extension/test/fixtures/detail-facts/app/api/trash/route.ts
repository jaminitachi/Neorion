import prisma, { custom } from '../../../lib/trash-prisma';

export async function GET() {
  const where = { ownerId: 'owner', deletedAt: { not: null } };
  await prisma.file.count({ where });
  await prisma.file.findMany({ where });

  const modified = { deletedAt: { not: null } };
  custom.file.count({ where: modified });
  await prisma.file.findMany({ where: modified });
  return Response.json({ ok: true });
}
