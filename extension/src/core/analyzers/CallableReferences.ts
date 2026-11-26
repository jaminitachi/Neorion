import { Node, SyntaxKind, ts, type Identifier, type SourceFile, type Symbol } from 'ts-morph';
import { visitKinds } from './CompilerWalk';

const identifiers = new Set([SyntaxKind.Identifier]);
const memberNames = new Set([SyntaxKind.Identifier, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral]);
type MemberSites = Map<string, (ts.Identifier | ts.StringLiteralLike)[]>;

/** Reuse checker symbols when a binding's references can be found by their spelling. */
export class CallableReferences {
  private cache = new WeakMap<Identifier, Node[]>();
  private programFiles?: SourceFile[];
  private moduleNames = new WeakMap<SourceFile, {
    imports: Map<string, string[]>;
    renamedExports: Set<string>;
  }>();
  private memberSites = new WeakMap<SourceFile, MemberSites>();

  constructor(private files: ReadonlySet<SourceFile>, private symbol: (node: Node) => Symbol | undefined,
    private exported: ReadonlySet<Node>) {}

  uses(name: Identifier): Node[] {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const declaration = name.getParent();
    const source = declaration.getSourceFile();
    const symbol = this.symbol(name);
    const enclosing = declaration.getFirstAncestor(node => Node.isFunctionLikeDeclaration(node) || Node.isFunctionExpression(node));
    const lexical = Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration) ||
      Node.isParameterDeclaration(declaration) || Node.isFunctionDeclaration(declaration);
    const module = ts.isExternalModule(source.compilerNode);
    const privateBinding = lexical && module && symbol?.getDeclarations().every(node => !this.exported.has(node));
    const text = name.compilerNode.text;
    const uses = !symbol ? [] :
      enclosing || privateBinding ? this.walk(enclosing && lexical ? enclosing : source, name, symbol, new Set([text])) :
      this.moduleUses(source, name, symbol) ?? name.findReferencesAsNodes();
    this.cache.set(name, uses);
    return uses;
  }

  private walk(scope: Node, name: Identifier, symbol: Symbol, names: ReadonlySet<string>, members = false, sites?: MemberSites) {
    const uses: Node[] = [];
    visitKinds(scope, members ? memberNames : identifiers, candidate => {
      if (candidate !== name && this.matches(candidate, symbol, members)) uses.push(candidate);
    }, {
      filterRaw: candidate => (ts.isIdentifier(candidate) || ts.isStringLiteralLike(candidate)) && names.has(candidate.text),
      visitRaw: sites && (node => {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
          let entries = sites.get(node.text);
          if (!entries) sites.set(node.text, entries = []);
          entries.push(node);
        }
      })
    });
    return uses;
  }

  private matches(candidate: Node, symbol: Symbol, members: boolean) {
    const parent = candidate.getParent();
    const target = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : this.symbol(candidate);
    return target === symbol || members && target?.getAliasedSymbol() === symbol;
  }

  private moduleUses(source: SourceFile, name: Identifier, symbol: Symbol) {
    // The general language-service search handles default exports, renamed
    // barrel exports, and ambient script bindings whose names can change.
    const declaration = name.getParent();
    const named = Node.isFunctionDeclaration(declaration) || Node.isVariableDeclaration(declaration);
    if (!ts.isExternalModule(source.compilerNode) ||
        (named ? declaration.isDefaultExport() : !Node.isMethodDeclaration(declaration))) return;
    const text = name.compilerNode.text;
    if (!this.programFiles) {
      const indexed = new Map([...this.files].map(file => [file.compilerNode, file]));
      this.programFiles = source.getProject().getProgram().compilerObject.getSourceFiles().flatMap(file => indexed.get(file) ?? []);
    }
    const uses: Node[] = [];
    const collect = (file: SourceFile) => {
      // The parser interns identifiers and property names, including escaped spelling.
      const parsed = file.compilerNode as ts.SourceFile & { identifiers?: ReadonlyMap<string, string> };
      if (parsed.identifiers ? !parsed.identifiers.has(text) :
          !parsed.text.includes(text) && !parsed.text.includes('\\u')) return true;
      let aliases: string[] | undefined;
      if (named) {
        let names = this.moduleNames.get(file);
        if (!names) {
          const imports = new Map<string, string[]>();
          const renamedExports = new Set<string>();
          for (const entry of file.getExportDeclarations()) {
            for (const specifier of entry.getNamedExports()) {
              if (specifier.getAliasNode()) renamedExports.add(specifier.getName());
            }
          }
          for (const entry of file.getImportDeclarations()) {
            for (const specifier of entry.getNamedImports()) {
              const alias = specifier.getAliasNode();
              if (!alias) continue;
              const name = specifier.getName();
              const entries = imports.get(name) ?? [];
              entries.push(alias.compilerNode.text);
              imports.set(name, entries);
            }
          }
          this.moduleNames.set(file, names = { imports, renamedExports });
        }
        if (names.renamedExports.has(text)) return false;
        aliases = names.imports.get(text);
      }
      uses.push(...this.moduleReferences(file, name, symbol, aliases));
      return true;
    };
    // Visit the declaration's file first, then follow imports in program order.
    if (!collect(source)) return;
    for (const file of this.programFiles) {
      if (file !== source && !collect(file)) return;
    }
    return uses;
  }

  private moduleReferences(file: SourceFile, name: Identifier, symbol: Symbol, aliases?: string[]) {
    const text = name.compilerNode.text;
    // Use ts-morph's existing context so symbols and wrapped nodes retain their identity.
    const wrap = (file as Node & { _getNodeFromCompilerNode?(node: ts.Node): Node })._getNodeFromCompilerNode;
    if (!wrap || aliases?.length) return this.walk(file, name, symbol, new Set([text, ...(aliases ?? [])]), true);
    const sites = this.memberSites.get(file);
    if (!sites) {
      const entries: MemberSites = new Map();
      const uses = this.walk(file, name, symbol, new Set([text]), true, entries);
      this.memberSites.set(file, entries);
      return uses;
    }
    const uses: Node[] = [];
    const definition = name.compilerNode;
    for (const node of sites.get(text) ?? []) {
      if (node === definition) continue;
      const candidate = wrap.call(file, node);
      if (this.matches(candidate, symbol, true)) uses.push(candidate);
    }
    return uses;
  }
}
