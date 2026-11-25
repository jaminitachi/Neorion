import { type SourceFile, ts } from 'ts-morph';
import type { RuntimeExports, RuntimeExportState } from '../../mcp/Index';

// The pinned compiler tracks type-only aliases through imports and re-exports
// separately from the final symbol, which can still have a value declaration.
type AliasChecker = ts.TypeChecker & { getTypeOnlyAliasDeclaration(symbol: ts.Symbol): ts.Declaration | undefined };

export function inspectRuntimeExports(files: SourceFile[]) {
  if (!files.length) return new Map<SourceFile, RuntimeExports>();
  const checker = files[0].getProject().getTypeChecker().compilerObject as AliasChecker;
  const modules = new Map(files.map(file => {
    const explicit = file.getSymbol()?.compilerSymbol.exports;
    const stars = file.getExportDeclarations().flatMap(entry => {
      if (entry.isTypeOnly() || entry.compilerNode.exportClause) return [];
      return [entry.getModuleSpecifierSourceFile()];
    });
    const direct = new Map<string, RuntimeExportState>();
    const forwarded: string[] = [];
    for (const exported of file.getExportSymbols()) {
      const symbol = exported.compilerSymbol;
      const name = exported.getName();
      if (!explicit?.has(symbol.escapedName)) {
        forwarded.push(name);
        continue;
      }
      const isAlias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
      const target = isAlias ? checker.getAliasedSymbol(symbol) : symbol;
      let state: RuntimeExportState;
      if (isAlias && checker.getTypeOnlyAliasDeclaration(symbol)) state = 'type';
      else if (!target.declarations?.length) state = 'unknown';
      else if (!(target.flags & ts.SymbolFlags.Value) && !target.declarations.some(ts.isSourceFile)) state = 'type';
      else if (target.declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)) state = 'unknown';
      else if (target.declarations.every(declaration => ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient)) state = 'type';
      else state = 'value';
      direct.set(name, state);
    }
    return [file, { direct, forwarded, stars }] as const;
  }));
  const visit = (file: SourceFile | undefined, seen: Set<SourceFile>, name?: string): RuntimeExportState => {
    if (!file) return 'unknown';
    const module = modules.get(file);
    if (!module) return 'unknown';
    if (seen.has(file)) return 'type';
    seen.add(file);
    const own = name === undefined ? undefined : module.direct.get(name);
    if (own) return own;
    let result: RuntimeExportState = 'type';
    for (const target of module.stars) {
      const state = visit(target, seen, name);
      if (state === 'value') return state;
      if (state === 'unknown') result = state;
    }
    return result;
  };
  return new Map<SourceFile, RuntimeExports>([...modules].map(([file, { direct, forwarded, stars }]) => [file, {
    names: Object.fromEntries([...direct, ...forwarded.map(name => [name, visit(file, new Set(), name)] as const)]),
    unknownStar: stars.length && visit(file, new Set()) === 'unknown' ? true : undefined
  }]));
}
