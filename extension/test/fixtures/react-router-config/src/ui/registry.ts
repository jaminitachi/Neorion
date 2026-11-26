import { register, index, layout, prefix } from './helpers';
const shared = 'route.tsx';
const options = { id: 'case-sensitive', caseSensitive: true };
const nested = [layout('section.tsx', [
  index('home.tsx'),
  register('left', shared, { id: 'left' }),
  register('right', shared, { id: 'right' })
])];
export const registry = [
  ...prefix('panel', nested),
  register('Case', 'home.tsx', options),
  register('users/:id?', 'home.tsx', { id: 'users' }),
  register('files/*', 'home.tsx', { id: 'files' }),
  register('receiver', 'receiver.ts'),
  register('guarded', 'guarded.ts'),
  register('gate', 'conditional.tsx', [register('child', 'home.tsx', { id: 'gated-child' })]),
  { id: 'index-shell', path: 'indexed', file: 'section.tsx', children: [index('index-form.tsx')] },
  register('uncoupled', 'no-outlet.tsx', [register('child', 'unmounted.tsx')])
];
