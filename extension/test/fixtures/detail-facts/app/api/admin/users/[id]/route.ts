import { store } from '../../../../../lib/prisma';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const input = await request.json();
  const updateData: Record<string, unknown> = {};
  if (input.name) updateData.name = input.name;
  if (input.email) updateData['email'] = input.email;
  const args = { where: { id }, data: updateData };
  return Response.json(await store.user.update(args));
}
