export type RouterPattern = {
  id: string;
  parentId?: string;
  pattern?: string;
  index?: boolean;
  caseSensitive?: boolean;
};

type Segment = { value: string; sensitive: boolean };
type MatchMode = 'url' | 'load' | 'submit';

const parts = (value: string) => value.split('/').filter(Boolean);
const parameter = /^:[\w-]+$/;

export function routerAncestry<T extends { router?: RouterPattern }>(entry: T, byId: ReadonlyMap<string, T>): T[] {
  const routes: T[] = [];
  const seen = new Set<T>();
  let current: T | undefined = entry;
  while (current && !seen.has(current)) {
    seen.add(current);
    routes.unshift(current);
    const parent: string | undefined = current.router?.parentId;
    current = parent ? byId.get(parent) : undefined;
  }
  return routes;
}

function scoreMatch(segments: Segment[], url: string[], index: boolean) {
  const memo = new Map<string, number>();
  const walk = (i: number, j: number): number => {
    if (i === segments.length) return j === url.length ? 0 : -Infinity;
    const key = i + '/' + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const { value, sensitive } = segments[i];
    if (value === '*' && i === segments.length - 1) return -1;
    const optional = value.endsWith('?');
    const token = optional ? value.slice(0, -1) : value;
    const param = parameter.test(token);
    const expected = sensitive ? token : token.toLowerCase();
    const actual = sensitive ? url[j] : url[j]?.toLowerCase();
    const take = actual !== undefined && (param || actual === expected) ? (param ? 4 : 11) + walk(i + 1, j + 1) : -Infinity;
    const best = optional ? Math.max(take, walk(i + 1, j)) : take;
    memo.set(key, best);
    return best;
  };
  return walk(0, 0) + (index ? 2 : 0);
}

export function matchRouterRoutes<T extends { router?: RouterPattern }>(input: string, all: T[], basename = '/',
  mode: MatchMode = 'url', candidates = all): T[] {
  const [pathname, search] = input.split('#', 1)[0].split('?', 2);
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return [];
  let url: string[];
  try {
    url = parts(pathname).map(decodeURIComponent);
  } catch {
    return [];
  }
  const base = parts(basename);
  if (base.length && base.every((part, i) => part.toLowerCase() === url[i]?.toLowerCase())) url = url.slice(base.length);
  const hasIndex = new URLSearchParams(search).getAll('index').includes('');
  const byId = new Map(all.flatMap(entry => entry.router ? [[entry.router.id, entry] as const] : []));
  let best = -Infinity;
  let result: T[] = [];
  for (const entry of candidates) {
    const route = entry.router;
    if (!route || !route.index && route.pattern === undefined && route.parentId) continue;
    if (hasIndex && !route.index || mode !== 'url' && !hasIndex && route.index) continue;
    let tokens: Segment[] = [];
    for (const { router } of routerAncestry(entry, byId)) {
      const { pattern, caseSensitive } = router!;
      if (!pattern) continue;
      const fragments = parts(pattern);
      if (pattern.startsWith('/')) fragments.splice(0, tokens.length);
      tokens = tokens.concat(fragments.map(value => ({ value, sensitive: !!caseSensitive })));
    }
    let score = scoreMatch(tokens, url, !!route.index);
    // The implicit root can receive data requests when no deeper route matches.
    if (!route.parentId) score -= 1;
    if (!Number.isFinite(score) || score < best) continue;
    if (score > best) result = [];
    best = score;
    result.push(entry);
  }
  return result;
}
