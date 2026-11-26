import { Node } from 'ts-morph';
import { bindingOf, importBinding, valueNode } from '../../analyzers/StaticBindings';

export function stringValue(node: Node | undefined) {
  const value = valueNode(node);
  return Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value) ? value.getLiteralText() : undefined;
}

export function booleanValue(node: Node | undefined) {
  const value = valueNode(node);
  return Node.isTrueLiteral(value) ? true : Node.isFalseLiteral(value) ? false : undefined;
}

export function properties(node: Node | undefined, seen = new Set<Node>()): Map<string, Node> | undefined {
  const value = valueNode(node);
  if (!Node.isObjectLiteralExpression(value) || seen.has(value) || seen.size >= 20) return;
  seen = new Set(seen).add(value);
  const entries = new Map<string, Node>();
  for (const property of value.getProperties()) {
    if (Node.isSpreadAssignment(property)) {
      const spread = properties(property.getExpression(), seen);
      if (!spread) return;
      for (const [key, value] of spread) entries.set(key, value);
    } else if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
      const name = property.getNameNode();
      const key = Node.isIdentifier(name) ? name.getText() : stringValue(name);
      const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() :
        Node.isShorthandPropertyAssignment(property) ? (property.getValueSymbol()?.getAliasedSymbol() ?? property.getValueSymbol())?.getDeclarations()[0] : property;
      if (key === undefined || !initializer) return;
      entries.set(key, initializer);
    } else return;
  }
  return entries;
}

export function stringList(node: Node | undefined, seen = new Set<Node>()): string[] | undefined {
  const value = valueNode(node);
  if (!Node.isArrayLiteralExpression(value) || seen.has(value) || seen.size >= 20) return;
  seen = new Set(seen).add(value);
  const entries: string[] = [];
  for (const element of value.getElements()) {
    if (Node.isSpreadElement(element)) {
      const spread = stringList(element.getExpression(), seen);
      if (!spread) return;
      entries.push(...spread);
    } else {
      const item = stringValue(element);
      if (item === undefined) return;
      entries.push(item);
    }
  }
  return entries;
}

// Resolve re-exported framework helpers from source, even without node_modules.
export function frameworkBinding(node: Node | undefined, seen = new Set<Node>()): { module: string; name: string } | undefined {
  if (!node || seen.has(node) || seen.size >= 16) return;
  seen.add(node);
  const imported = importBinding(node);
  if (imported) {
    const source = imported.declaration.getModuleSpecifierSourceFile();
    if (!source || source.isInNodeModules()) return imported;
    const name = imported.name;
    for (const statement of source.getExportDeclarations()) {
      if (statement.isTypeOnly()) continue;
      const specifier = statement.getNamedExports().find(entry => !entry.isTypeOnly() &&
        (entry.getAliasNode() ?? entry.getNameNode()).getText() === name);
      if (specifier && statement.getModuleSpecifier()) {
        const module = statement.getModuleSpecifierValue()!;
        const target = statement.getModuleSpecifierSourceFile();
        if (!target || target.isInNodeModules()) return { module, name: specifier.getName() };
      }
      if (specifier) {
        const binding = frameworkBinding(specifier.getNameNode(), seen);
        if (binding) return binding;
      }
    }
    for (const declaration of source.getExportedDeclarations().get(name) ?? []) {
      const binding = frameworkBinding(declaration, seen);
      if (binding) return binding;
    }
    return;
  }
  const declaration = bindingOf(node);
  const value = Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === 'const'
    ? declaration.getInitializer() : valueNode(node);
  return value !== node ? frameworkBinding(value, seen) : undefined;
}
