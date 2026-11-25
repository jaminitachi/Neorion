export interface NextUrlConfig {
  basePath?: string;
  locales?: string[];
  trailingSlash?: boolean;
}

export const routeSegments = (url: string) => url === '/' ? [] : url.slice(1).split('/');

export const segmentRank = (segment: string) =>
  /^\[\[\.\.\..+\]\]$/.test(segment) ? '0' : /^\[\.\.\..+\]$/.test(segment) ? '1' :
    /^\[.+\]$/.test(segment) ? '2' : '3';

export const patternRank = (segments: string[]) => segments.map(segmentRank).join('');

export function normalizeNextUrl(url: string, config?: NextUrlConfig) {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return;
  let pathname = url.split(/[?#]/, 1)[0];
  if (config?.basePath && (pathname === config.basePath || pathname.startsWith(config.basePath + '/'))) {
    pathname = pathname.slice(config.basePath.length) || '/';
  }
  const locale = pathname.split('/')[1];
  if (config?.locales?.includes(locale)) pathname = pathname.slice(locale.length + 1) || '/';
  return pathname.replace(/\/$/, '') || '/';
}

export function matchNextRoutes<T>(url: string, routes: T[], pattern: (route: T) => string,
  config?: NextUrlConfig, compatible = (part: string, segment: string) => segmentRank(part) !== '3' || part === segment): T[] {
  const pathname = normalizeNextUrl(url, config);
  if (!pathname) return [];
  const segments = routeSegments(pathname);
  let best = '';
  let matches: T[] = [];
  for (const route of routes) {
    const parts = routeSegments(pattern(route));
    if (!parts.every((part, i) => segmentRank(part) === '0' ||
      (!!segments[i] && compatible(part, segments[i]))) ||
      (parts.length !== segments.length && !['0', '1'].includes(segmentRank(parts.at(-1) ?? '')))) continue;
    const rank = patternRank(parts);
    if (rank < best) continue;
    if (rank > best) matches = [];
    best = rank;
    matches.push(route);
  }
  return matches;
}

type MatcherPart = { text?: string; optional?: boolean; repeat?: boolean };

function membership(pattern: MatcherPart[], route: MatcherPart[]) {
  // Literal segments and one other segment partition the input alphabet.
  const alphabet = [...new Set([...pattern, ...route].flatMap(part => part.text === undefined ? [] : [part.text])), '\0'];
  const closure = (parts: MatcherPart[], states: number[]) => {
    const next = new Set(states);
    for (const index of next) if (parts[index]?.optional) next.add(index + 1);
    return [...next].sort((a, b) => a - b);
  };
  const advance = (parts: MatcherPart[], states: number[], token: string) => closure(parts,
    states.flatMap(index => {
      const part = parts[index];
      return !part || part.text !== undefined && part.text !== token ? [] :
        part.repeat ? [index, index + 1] : [index + 1];
    }));
  const pending = [[closure(pattern, [0]), closure(route, [0])]];
  const seen = new Set<string>();
  let overlap = false;
  let excluded = false;
  for (let i = 0; i < pending.length; i++) {
    if (i >= 512 || overlap && excluded) return 'possible';
    const [left, right] = pending[i];
    const key = JSON.stringify([left, right]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (right.includes(route.length)) {
      if (left.includes(pattern.length)) overlap = true;
      else excluded = true;
    }
    for (const token of alphabet) {
      const variants = advance(route, right, token);
      if (variants.length) pending.push([advance(pattern, left, token), variants]);
    }
  }
  return overlap ? 'yes' : 'no';
}

export function compileMiddlewareMatcher(pattern: string) {
  if (!pattern.startsWith('/')) return;
  const parts = routeSegments(pattern.replace(/\/$/, '') || '/');
  const negative = /^\/\(\(\?!(.+)\)\.\*\)$/.exec(pattern);
  if (negative && negative[1].split('|').every(part => /^[\w./-]+$/.test(part))) {
    const excluded = negative[1].split('|');
    const prefixes = excluded.map(value => new RegExp('^(?:' + value + ')'));
    return (pathname: string, concrete = false): 'yes' | 'possible' | 'no' => {
      const variants = routeSegments(pathname);
      const dynamic = concrete ? -1 : variants.findIndex(part => segmentRank(part) !== '3');
      const prefix = variants.slice(0, dynamic < 0 ? variants.length : dynamic).join('/');
      if (dynamic < 0) return prefixes.some(regex => regex.test(prefix)) ? 'no' : 'yes';
      if (excluded.some(value => prefix.startsWith(value) && !value.includes('.'))) return 'no';
      return excluded.some(value => value.startsWith(prefix ? prefix + '/' : '')) ? 'possible' : 'yes';
    };
  }
  if (parts.some(part => !/^(?:[\w.~-]+|:\w+[?*+]?)$/.test(part))) return;
  const patternParts = parts.map(part => part.startsWith(':') ?
    { optional: /[?*]$/.test(part), repeat: /[+*]$/.test(part) } : { text: part });
  const fixed = !patternParts.some(part => part.optional || part.repeat);
  return (pathname: string, concrete = false): 'yes' | 'possible' | 'no' => {
    const route = routeSegments(pathname).map(part => {
      const rank = concrete ? '3' : segmentRank(part);
      return rank === '3' ? { text: part } : { optional: rank === '0', repeat: rank !== '2' };
    });
    if (fixed && !route.some(part => part.repeat)) {
      if (route.length !== patternParts.length || patternParts.some(({ text }, i) =>
        text !== undefined && route[i].text !== undefined && text !== route[i].text)) return 'no';
      return patternParts.some(({ text }, i) => text !== undefined && route[i].text === undefined) ? 'possible' : 'yes';
    }
    return membership(patternParts, route);
  };
}

export function middlewareMatcher(pattern: string, pathname: string, concrete = false) {
  return compileMiddlewareMatcher(pattern)?.(pathname, concrete);
}
