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
