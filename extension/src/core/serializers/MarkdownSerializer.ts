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
    const primitiveGroups = new Map<string, number>();
    for (const component of graph.components) {
      const directory = /^(?:src\/)?components\/ui(?=\/)/.exec(component.path)?.[0];
      if (!directory || routeComponents.has(component.id)) continue;
      const group = `cmp:${directory}`;
      primitives.set(component.id, group);
      primitiveGroups.set(group, (primitiveGroups.get(group) ?? 0) + 1);
    }
    const relationships = new Map<string, { from: string; to: string; type: string }>();
    for (const edge of graph.edges) {
      if (primitives.has(edge.from)) continue;
      const to = primitives.get(edge.to) ?? edge.to;
      const key = JSON.stringify([edge.from, to]);
      const previous = relationships.get(key);
      const types = new Set(previous?.type.split(' '));
      types.add(edge.type);
      relationships.set(key, { ...edge, to, type: [...types].join(' ') });
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
        ...[...primitiveGroups].map(([id, count]) => element('component-group', { id, count: String(count) }))]),
      section('hooks', graph.hooks.map(hook => element('hook', { id: hook.id }))),
      section('server-actions', graph.actions.map(id => element('action', { id }))),
      section('edges', [...relationships.values()].map(edge => element('edge', edge))),
      section('dependencies', graph.libraries.map(library => element('lib', { ...library }))),
      '</codebase>', '```', ''
    ].join('\n');
  }
}
