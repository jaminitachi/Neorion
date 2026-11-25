export const sourceFile = /\.[cm]?[jt]sx?$/;
export const routeAsset = /(?:\.css|(?:^|\/)(?:robots\.txt|sitemap\.xml|opengraph-image\.(?:png|jpe?g|gif)))$/;

export const historicalInput = (file: string) =>
  sourceFile.test(file) || file.endsWith('.json') || /(?:^|\/)pnpm-workspace\.yaml$/.test(file) || routeAsset.test(file);

export type HistoryEdit = { file: string; names: string[] };
