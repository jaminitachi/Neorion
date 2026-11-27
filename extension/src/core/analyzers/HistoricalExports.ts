import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Node, Project, ts, type CallExpression } from 'ts-morph';
import { historyEnvironmentSupported, listHistoryInputs, sourceFile, type HistoryEdit } from '../HistoryInputs';
import { projectSnapshot } from '../ProjectSnapshot';
import { isTestFile, type IndexedReference, type QueryIndex } from '../../mcp/Index';
import { startLine } from './SourceLines';
import { bindingOf, importBinding } from './StaticBindings';

export type HistoryPlan = { root: string; edits: HistoryEdit[]; live: QueryIndex };

const scalarParameters = new Set([ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword]);

function isolatedCall(call: CallExpression) {
  const parent = call.getParent();
  if (Node.isExpressionStatement(parent)) return true;
  if (!Node.isCallExpression(parent)) return false;
  const callee = parent.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.getExpression();
  if (Node.isIdentifier(receiver) && receiver.getText() === 'Response' && !bindingOf(receiver) &&
      callee.getName() === 'json' && Node.isReturnStatement(parent.getParent())) return true;
  if (callee.getName() !== 'set' || !Node.isExpressionStatement(parent.getParent()) || parent.getArguments()[1] !== call) return false;
  // Next's cookie setter consumes the result as data without introducing a
  // local callback, component, or request destination.
  const declaration = bindingOf(receiver);
  const awaitCall = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  const cookies = Node.isAwaitExpression(awaitCall) ? awaitCall.getExpression() : awaitCall;
  const origin = Node.isCallExpression(cookies) ? importBinding(cookies.getExpression()) : undefined;
  return origin?.module === 'next/headers' && origin.name === 'cookies';
}

// Reuse the live graph only when the comparison restores ordinary function
// exports and all other graph inputs agree. The new incoming edges come from
// statically bound call sites in the base importers.
export function incrementalHistory(base: string, { root, edits, live }: HistoryPlan): QueryIndex | undefined {
  const fileIds = new Map(Object.keys(live.files).map((file, offset) => [file, live.fileSymbols![offset]]));
  const editsByFile = new Map(edits.map(({ file, names }) => [file, names]));
  const originIds = new Map<string, Map<string, number>>();
  const sources = new Map<string, string>();
  const config = join(base, 'tsconfig.json');
  if (!existsSync(config) || live.pagesWorkspaceInputs || live.routes.some(route => route.pages)) return;
  if (!historyEnvironmentSupported(root)) return;
  const readConfig = ts.readConfigFile(config, ts.sys.readFile);
  if (readConfig.error || readConfig.config.extends || readConfig.config.references) return;
  const settings = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, base, undefined, config);
  if (settings.errors.length || [ts.ModuleResolutionKind.Node16, ts.ModuleResolutionKind.NodeNext]
    .includes(settings.options.moduleResolution!)) return;

  const beforeFiles = listHistoryInputs(base);
  const afterFiles = listHistoryInputs(root);
  if (!beforeFiles || !afterFiles || beforeFiles.size !== afterFiles.size) return;
  for (const file of beforeFiles) {
    if (!afterFiles.has(file)) return;
    const before = readFileSync(join(base, file));
    const after = readFileSync(join(root, file));
    if (!editsByFile.has(file) && !before.equals(after)) return;
    if (fileIds.has(file) && createHash('sha1').update(after).digest('hex') !== live.files[file].sha1) return;
    if (sourceFile.test(file)) sources.set(file, before.toString('utf8'));
  }
  if ([...fileIds.keys()].some(file => !beforeFiles.has(file))) return;
  const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true, compilerOptions: { noLib: true, skipLibCheck: true } });
  for (const [file, names] of editsByFile) {
    const text = sources.get(file);
    const module = fileIds.get(file);
    if (!text || module === undefined || Object.prototype.hasOwnProperty.call(live.routeFiles!, file) || /\buse (?:client|server)\b/.test(text)) return;
    const source = project.createSourceFile(file, text);
    const restorations = new Map<string, number>();
    const ranges: [number, number][] = [];
    for (const name of names) {
      // Components, hooks and action exports can participate in synthetic edges.
      if (!/^[a-z][\w$]*$/.test(name) || /^use[A-Z0-9]/.test(name)) return;
      const declarations = source.getFunctions().filter(fn => fn.getName() === name);
      const fn = declarations[0];
      const marker = fn?.getModifiers().find(node => node.getKind() === ts.SyntaxKind.ExportKeyword);
      if (declarations.length !== 1 || !marker || fn.isDefaultExport() || !fn.getBody()) return;
      if (fn.getParameters().some(parameter => !Node.isIdentifier(parameter.getNameNode()) ||
          !scalarParameters.has(parameter.getTypeNode()?.getKind() ?? ts.SyntaxKind.Unknown))) return;
      const candidates = live.symbols.filter(symbol => symbol.file === file && symbol.name === name && symbol.kind === 'function');
      if (candidates.length !== 1 || candidates[0].exported || candidates[0].line !== startLine(fn) ||
          Object.prototype.hasOwnProperty.call(live.runtimeExports?.[module]?.names ?? {}, name)) return;
      const end = marker.getEnd();
      const whitespace = /^[ \t]+/.exec(text.slice(end))?.[0].length ?? 0;
      if (!whitespace) return;
      ranges.push([marker.getStart(), end + whitespace]);
      restorations.set(name, candidates[0].id);
    }
    let withoutExports = text;
    for (const [start, end] of ranges.sort(([a], [b]) => b - a)) {
      withoutExports = withoutExports.slice(0, start) + withoutExports.slice(end);
    }
    if (withoutExports !== readFileSync(join(root, file), 'utf8') ||
        !ts.isExternalModule(ts.createSourceFile(file, withoutExports, ts.ScriptTarget.Latest))) return;
    originIds.set(file, restorations);
  }

  const newReferences: IndexedReference[] = [];
  const modules = ts.createModuleResolutionCache(base, ts.sys.useCaseSensitiveFileNames ? name => name : name => name.toLowerCase(), settings.options);
  const targetIds = new Set([...originIds.keys()].map(file => fileIds.get(file)!));
  for (const [file, text] of sources) {
    const absolute = join(base, file);
    const known = (live.moduleImports![fileIds.get(file)!] ?? []).filter(([target]) => targetIds.has(target));
    const targets = new Map<string, string>();
    const imports = ts.preProcessFile(text, true, true).importedFiles.filter(({ fileName }) => {
      const resolved = ts.resolveModuleName(fileName, absolute, settings.options, ts.sys, modules).resolvedModule?.resolvedFileName;
      const target = resolved && relative(base, resolved).split(sep).join('/');
      if (!target || !originIds.has(target)) return false;
      targets.set(fileName, target);
      return true;
    });
    if (!imports.length && !known.length) continue;
    // Runtime and type namespace access, dynamic loading and re-exports need
    // a historical graph because they can change bindings in other modules.
    if (!fileIds.has(file) || originIds.has(file) || imports.length !== known.length ||
        known.some(([, , kind, bindings]) => kind !== 'import' || !bindings?.length ||
          bindings.some(([name]) => name === '*' || name === 'default'))) return;
    const source = project.createSourceFile(file, text);
    const declarations = source.getImportDeclarations().filter(entry => targets.has(entry.getModuleSpecifierValue()));
    if (declarations.length !== imports.length) return;
    for (const entry of declarations) {
      const target = targets.get(entry.getModuleSpecifierValue())!;
      const bindingIds = originIds.get(target)!;
      if (!known.some(([id, line]) => id === fileIds.get(target) && line === startLine(entry))) return;
      for (const binding of entry.getNamedImports()) {
        const id = bindingIds.get(binding.getName());
        if (id === undefined) continue;
        const local = binding.getAliasNode() ?? binding.getNameNode();
        for (const reference of local.findReferencesAsNodes()) {
          const call = reference.getParent();
          if (call === binding || reference.getSourceFile() !== source) continue;
          if (!Node.isCallExpression(call) || call.getExpression() !== reference || call.hasQuestionDotToken()) return;
          const line = startLine(call);
          if (isTestFile(file)) {
            newReferences.push([id, file, line, 'call']);
            continue;
          }
          // A top-level App Router handler has a stable owner. Other caller
          // shapes may participate in prop flow, callbacks or tRPC aliases.
          const fn = call.getFirstAncestor(Node.isFunctionLikeDeclaration);
          const route = live.routes.find(route => route.kind === 'api' && route.file === file);
          if (!route || !Node.isFunctionDeclaration(fn) || fn.getParent() !== source ||
              live.trpcFiles?.includes(file) || !isolatedCall(call)) return;
          const owner = route.handlers?.[fn.getName() ?? ''];
          if (!owner || live.symbols[owner - 1]?.line !== startLine(fn)) return;
          newReferences.push([id, file, line, 'call', undefined, owner]);
        }
      }
    }
  }

  if (live.projectSnapshot !== projectSnapshot(root)) return;
  const exportSymbols = { ...live.exportSymbols };
  const runtimeExports = { ...live.runtimeExports };
  for (const [file, bindings] of originIds) {
    const id = fileIds.get(file)!;
    exportSymbols[id] = { ...exportSymbols[id], ...Object.fromEntries([...bindings].map(([name, symbol]) => [name, [symbol]])) };
    runtimeExports[id] = { ...runtimeExports[id], names: {
      ...runtimeExports[id]?.names, ...Object.fromEntries([...bindings.keys()].map(name => [name, 'value' as const]))
    } };
  }
  return { ...live, exportSymbols, runtimeExports, references: [...live.references, ...newReferences] };
}
