import type { CodebaseGraph } from '../types/GraphTypes';

type Attribute = string | boolean | undefined;

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    '`': '&#96;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;'
  };
  return value.replace(/[&<>"'`\n\r\t]/g, character => entities[character]);
}

function element(name: string, attributes: Record<string, Attribute>, text?: string): string {
  const attrs = Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined ? [] : [` ${key}="${escapeXml(String(value))}"`]).join('');
  return text ? `<${name}${attrs}>${escapeXml(text)}</${name}>` : `<${name}${attrs} />`;
}

function section(name: string, entries: string[]): string {
  return [`  <${name}>`, ...entries.map(entry => `    ${entry}`), `  </${name}>`].join('\n');
}

export class MarkdownSerializer {
  public serialize(graph: CodebaseGraph): string {
    const routeComponents = new Set(graph.routes.map(route => route.componentId));
    const primitives = new Map<string, string>();
    for (const component of graph.components) {
      const directory = /^(?:src\/)?components\/ui(?=\/)/.exec(component.path)?.[0];
      if (!directory || !component.primitiveCandidate || component.hooks.length || routeComponents.has(component.id)) continue;
      primitives.set(component.id, `cmp:${directory}`);
    }
    // A component can only be folded if all components it renders can also be folded.
    let changed: boolean;
    do {
      changed = false;
      for (const edge of graph.edges) {
        if (edge.type === 'uses-action' || (edge.type === 'renders' && !primitives.has(edge.to))) {
          if (primitives.delete(edge.from)) changed = true;
        }
      }
    } while (changed);
    const primitiveGroups = new Map<string, { count: number; files: Set<string> }>();
    for (const component of graph.components) {
      const id = primitives.get(component.id);
      if (!id) continue;
      const group = primitiveGroups.get(id) ?? { count: 0, files: new Set<string>() };
      group.count++;
      group.files.add(component.path.slice(id.length - 'cmp:'.length + 1));
      primitiveGroups.set(id, group);
    }
    const relationships = new Map<string, Record<string, Attribute> & { type: string }>();
    for (const edge of graph.edges) {
      const fromGroup = primitives.get(edge.from);
      const toGroup = primitives.get(edge.to);
      const key = JSON.stringify([edge.from, edge.to]);
      const previous = relationships.get(key);
      const types = new Set(previous?.type.split(' '));
      types.add(edge.type);
      relationships.set(key, {
        from: fromGroup ?? edge.from, to: toGroup ?? edge.to, type: [...types].join(' '),
        fromMember: fromGroup && edge.from.slice(fromGroup.length + 1),
        toMember: toGroup && edge.to.slice(toGroup.length + 1)
      });
    }
    return [
      '# Codebase Architecture Map', '', '```xml',
      `<codebase name="${escapeXml(graph.metadata.name)}" framework="nextjs" router="${graph.metadata.router}" language="ts">`,
      section('directories', graph.metadata.directories.map(directory => element('dir', { ...directory }))),
      section('routes', graph.routes.map(route => element('route', {
        id: route.id, path: route.path, scope: route.scope, type: route.type,
        methods: route.methods?.join(' '), wraps: route.wraps?.length ? route.wraps.join(' ') : undefined, component: route.componentId, isClient: route.isClient
      }))),
      section('components', [...graph.components.filter(component => !primitives.has(component.id)).map(component => element('component', {
        id: component.id, isClient: component.isClient,
        props: component.props.length ? component.props.join(' ') : undefined,
        hooks: component.hooks.length ? component.hooks.join(' ') : undefined
      }, component.description)),
        ...[...primitiveGroups].map(([id, { count, files }]) =>
          element('component-group', { id, count: String(count), files: [...files].sort().join(' ') }))]),
      section('hooks', graph.hooks.map(hook => element('hook', { id: hook.id }))),
      section('server-actions', graph.actions.map(id => element('action', { id }))),
      section('edges', [...relationships.values()].map(edge => element('edge', edge))),
      section('dependencies', graph.libraries.map(library => element('lib', { ...library }))),
      ...(graph.devDependencies.length ? [
        '  ' + element('dev-dependencies', { names: graph.devDependencies.join(' ') })
      ] : []),
      '</codebase>', '```', ''
    ].join('\n');
  }
}
