type MetadataRouteKind = 'robots' | 'sitemap' | 'opengraph-image';

export function metadataRouteKind(filename: string, atRoot: boolean): MetadataRouteKind | undefined {
  const match = /^(robots|sitemap|opengraph-image)\.[jt]sx?$/.exec(filename)
    ?? /^(opengraph-image)\.(?:png|jpg|jpeg|gif)$/.exec(filename)
    ?? /^(sitemap)\.xml$/.exec(filename)
    ?? (atRoot ? /^(robots)\.txt$/.exec(filename) : null);
  return match?.[1] as MetadataRouteKind | undefined;
}
