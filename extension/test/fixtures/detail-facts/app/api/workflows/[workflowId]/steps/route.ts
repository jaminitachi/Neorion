import { store } from '../../../../../lib/prisma';

declare function addRecipients(value: string[]): void;

export async function POST() {
  const allowListItems: string[] = [];
  allowListItems.push('viewer@example.com');
  await store.link.update({ data: { allowList: allowListItems } });

  const runs: string[] = [];
  runs.splice(0, 0, 'queued');
  const errors: string[] = [];
  errors.unshift('failed');
  const indexed: string[] = [];
  indexed[0] = 'added';
  const names = new Map();
  names.set('id', 'viewer');
  const members = new Set();
  members.add('viewer');
  const recipients = { all: [] as string[] };
  addRecipients(recipients.all);
  const aliasTarget: string[] = [];
  const alias = aliasTarget;
  alias.push('viewer');

  const unchanged = ['keep'];
  return Response.json({ runs, errors, indexed, names, members, recipients, aliasTarget, unchanged }, { status: 500 });
}
