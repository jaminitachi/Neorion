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
    const relationships = new Map<string, { from: string; to: string; type: string }>();
    for (const edge of graph.edges) {
      const key = JSON.stringify([edge.from, edge.to]);
      const previous = relationships.get(key);
      relationships.set(key, { ...edge, type: previous ? `${previous.type} ${edge.type}` : edge.type });
    }
    return [
      '# Codebase Architecture Map', '', '```xml',
      `<codebase name="${escapeXml(graph.metadata.name)}" framework="nextjs" router="app" language="ts">`,
      section('directories', graph.metadata.directories.map(directory => element('dir', { ...directory }))),
      section('routes', graph.routes.map(route => element('route', {
        id: route.id, path: route.path, file: route.file, type: route.type,
        methods: route.methods?.join(' '), component: route.componentId, isClient: route.isClient
      }))),
      section('components', graph.components.map(component => element('component', {
        id: component.id, name: component.name, path: component.path, isClient: component.isClient,
        props: component.props.length ? component.props.join(' ') : undefined,
        hooks: component.hooks.length ? component.hooks.join(' ') : undefined
      }, component.description))),
      section('hooks', graph.hooks.map(hook => element('hook', { ...hook }))),
      section('edges', [...relationships.values()].map(edge => element('edge', edge))),
      section('dependencies', graph.libraries.map(library => element('lib', { ...library }))),
      '</codebase>', '```', ''
    ].join('\n');
  }
}
