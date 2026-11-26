import { Node, SyntaxKind, ts, type Identifier, type SourceFile, type Symbol } from 'ts-morph';
import { visitKinds } from './CompilerWalk';

const identifiers = new Set([SyntaxKind.Identifier]);
const memberNames = new Set([SyntaxKind.Identifier, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral]);

/** Reuse checker symbols when a binding's references can be found by their spelling. */
export class CallableReferences {
  private cache = new WeakMap<Identifier, Node[]>();
  private programFiles?: SourceFile[];

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

  private walk(scope: Node, name: Identifier, symbol: Symbol, names: ReadonlySet<string>, members = false) {
    const uses: Node[] = [];
    visitKinds(scope, members ? memberNames : identifiers, candidate => {
      if (candidate === name) return;
      const parent = candidate.getParent();
      const target = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : this.symbol(candidate);
      if (target === symbol || members && target?.getAliasedSymbol() === symbol) uses.push(candidate);
    }, {
      filterRaw: candidate => (ts.isIdentifier(candidate) || ts.isStringLiteralLike(candidate)) && names.has(candidate.text)
    });
    return uses;
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
    // Visit the declaration's file first, then follow imports in program order.
    for (const file of [source, ...this.programFiles.filter(file => file !== source)]) {
      const content = file.compilerNode.text;
      if (!content.includes(text) && !content.includes('\\u')) continue;
      const names = new Set([text]);
      if (named) {
        for (const entry of file.getExportDeclarations()) {
          for (const specifier of entry.getNamedExports()) {
            const alias = specifier.getAliasNode();
            if (alias && specifier.getName() === text) return;
          }
        }
        for (const entry of file.getImportDeclarations()) {
          for (const specifier of entry.getNamedImports()) {
            const alias = specifier.getAliasNode();
            if (alias && specifier.getName() === text) names.add(alias.compilerNode.text);
          }
        }
      }
      uses.push(...this.walk(file, name, symbol, names, true));
    }
    return uses;
  }
}
