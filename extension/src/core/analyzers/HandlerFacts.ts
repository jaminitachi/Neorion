import { Node, SyntaxKind, ts } from 'ts-morph';
import type { DetailFact } from '../../mcp/Index';
import { visitKinds } from './CompilerWalk';
import { startLine } from './SourceLines';
import { constInitializer, expressionLabel, literalLabel, objectFields, unwrapFact } from './FactSyntax';
import { functionNode, importBinding, valueNode } from './StaticBindings';

const handlerKinds = new Set([
  SyntaxKind.AwaitExpression, SyntaxKind.CallExpression, SyntaxKind.NewExpression,
  SyntaxKind.ReturnStatement, SyntaxKind.TaggedTemplateExpression
]);
const modelOperations = new Set([
  'aggregate', 'count', 'create', 'createMany', 'createManyAndReturn', 'delete', 'deleteMany', 'findFirst',
  'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'groupBy', 'update', 'updateMany',
  'updateManyAndReturn', 'upsert'
]);

function shape(node: Node | undefined, depth = 4): { text: string; partial?: true } {
  const literal = literalLabel(node, depth);
  if (literal !== undefined) return { text: literal };
  const alias = depth > 0 ? constInitializer(node) : undefined;
  const constant = literalLabel(alias, depth);
  if (constant !== undefined) return { text: constant };
  const properties = depth > 0 ? objectFields(node) ?? objectFields(alias) : undefined;
  if (!properties) return { text: expressionLabel(node), partial: true };
  const fields = properties.fields.map(({ key, value }) => {
    const entry = shape(value, depth - 1);
    return { text: key + ': ' + entry.text, partial: entry.partial };
  });
  return {
    text: '{ ' + [...fields.map(field => field.text), ...(properties.opaque ? ['<unresolved keys>'] : [])].join(', ') + ' }',
    partial: properties.opaque || fields.some(field => field.partial) ? true : undefined
  };
}

function isContextParams(node: Node, params: Node | undefined) {
  if (!params) return false;
  if (Node.isIdentifier(node)) {
    const declaration = node.getSymbol()?.getDeclarations()[0];
    if (!Node.isBindingElement(declaration) || declaration.getParent().getParent() !== params) return false;
    return (declaration.getPropertyNameNode() ?? declaration.getNameNode()).getText() === 'params';
  }
  return Node.isPropertyAccessExpression(node) && node.getName() === 'params' &&
    node.getExpression().getSymbol()?.getDeclarations()[0] === params;
}

export function handlerFacts(declaration: Node | undefined, relative: (node: Node) => string): DetailFact[] {
  const fn = functionNode(declaration);
  const body = fn?.getBody();
  if (!fn || !body) return [];
  const rows: DetailFact[] = [];
  const file = relative(fn);
  const add = (node: Node, text: string, reason?: string) => rows.push([file, startLine(node), text, reason]);
  add(fn, 'exported handler');
  const context = fn.getParameters()[1];
  const calls = new Set<string>();
  let opaque = false;
  const visit = (node: Node) => {
    if (Node.isAwaitExpression(node) && isContextParams(node.getExpression(), context)) {
      const declaration = node.getParent();
      const name = Node.isVariableDeclaration(declaration) ? declaration.getNameNode() : undefined;
      const keys = Node.isObjectBindingPattern(name) ? name.getElements().map(element =>
        expressionLabel(element.getPropertyNameNode() ?? element.getNameNode())) : [];
      add(node, 'await params' + (keys.length ? ' destructures ' + keys.join(', ') :
        name ? ' → ' + expressionLabel(name) : ''));
      return;
    }
    if (Node.isReturnStatement(node)) {
      const expression = unwrapFact(node.getExpression());
      if (!isJsonResponse(expression)) {
        add(node, 'return ' + expressionLabel(expression), 'response shape unresolved');
      }
      return;
    }
    if (Node.isNewExpression(node) || Node.isTaggedTemplateExpression(node)) {
      const target = Node.isNewExpression(node) ? node.getExpression() : node.getTag();
      add(node, (Node.isNewExpression(node) ? 'construct ' : 'tagged call ') + expressionLabel(target),
        'callee bodies not inspected');
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = unwrapFact(node.getExpression());
    if (callee?.getKind() === SyntaxKind.ImportKeyword) return;
    if (isJsonResponse(node)) {
      const [payload, options] = node.getArguments();
      const result = shape(constInitializer(payload) ?? payload);
      const status = options ? objectFields(options)?.fields.find(field => field.key === 'status')?.value : undefined;
      add(node, 'JSON response ' + (status ? expressionLabel(status) + ' ' : '') + result.text,
        result.partial || options && literalLabel(options) === undefined ? 'response values unresolved' : undefined);
      return;
    }
    if (Node.isPropertyAccessExpression(callee) && modelOperations.has(callee.getName())) {
      const model = callee.getExpression();
      if (Node.isPropertyAccessExpression(model)) {
        const client = model.getExpression();
        const origin = importBinding(client);
        // The call itself is evidence. A conventional name alone cannot prove
        // that this object is a Prisma client.
        const initialized = constInitializer(client);
        const prismaImport = (module: string | undefined) => module === '@prisma/client' ||
          /(?:^|\/)generated\/prisma(?:\/client)?$/.test(module ?? '');
        const prisma = prismaImport(origin?.module) ||
          origin?.declaration.getModuleSpecifierSourceFile()?.getImportDeclarations()
            .some(entry => prismaImport(entry.getModuleSpecifierValue()) &&
              entry.getNamedImports().some(binding => binding.getName() === 'PrismaClient')) ||
          Node.isNewExpression(initialized) && prismaImport(importBinding(initialized.getExpression())?.module);
        const args = node.getArguments();
        const result = args.length ? shape(constInitializer(args[0]) ?? args[0]) : undefined;
        add(node, (prisma ? 'Prisma ' : 'model-shaped call ') + expressionLabel(callee) +
          (result ? '(' + result.text + ')' : '()'),
        !prisma ? 'ORM receiver unresolved' : result?.partial ? 'ORM argument values unresolved' : undefined);
        return;
      }
    }
    if (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) {
      const base = expressionLabel(callee);
      const literalArgs = Node.isPropertyAccessExpression(callee) && ['get', 'has'].includes(callee.getName())
        ? node.getArguments().map(arg => literalLabel(arg)) : [];
      const label = literalArgs.length && literalArgs.every(arg => arg !== undefined)
        ? base + '(' + literalArgs.join(', ') + ')' : base;
      if (!calls.has(label)) {
        calls.add(label);
        add(node, 'call ' + label, 'callee bodies not inspected');
      }
    } else opaque = true;
  };
  if (!Node.isBlock(body) && !isJsonResponse(body)) add(body, 'return ' + expressionLabel(body), 'response shape unresolved');
  visit(body);
  visitKinds(body, handlerKinds, visit, { skipNode: node => ts.isFunctionLike(node) || ts.isClassLike(node) });
  if (opaque) add(fn, 'computed or indirect calls', 'call targets unresolved');
  return rows;
}

function isJsonResponse(node: Node | undefined) {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'json') return false;
  const receiver = callee.getExpression();
  const origin = importBinding(receiver);
  if (origin?.module === 'next/server' && origin.name === 'NextResponse') return true;
  if (!Node.isIdentifier(receiver) || receiver.getText() !== 'Response') return false;
  return (receiver.getSymbol()?.getDeclarations() ?? []).every(declaration => declaration.getSourceFile().isDeclarationFile()) &&
    valueNode(receiver) === receiver;
}
