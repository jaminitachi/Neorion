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
    const uiDirectory = /^(?:src\/)?components\/ui\//;
    const componentsById = new Map(graph.components.map(component => [component.id, component]));
    const unfolded = new Set(graph.components.filter(component =>
      !uiDirectory.test(component.path) || !component.primitiveCandidate ||
      component.hooks.length || routeComponents.has(component.id)
    ).map(component => component.path));

    // Keep all exports of a file together and propagate through render dependencies.
    let changed: boolean;
    do {
      changed = false;
      for (const edge of graph.edges) {
        const from = componentsById.get(edge.from);
        const to = componentsById.get(edge.to);
        if (!from || unfolded.has(from.path)) continue;
        if (edge.type === 'uses-action' || (edge.type === 'renders' && to && unfolded.has(to.path))) {
          unfolded.add(from.path);
          changed = true;
        }
      }
    } while (changed);

    const memberIds = new Map<string, string>();
    const primitiveGroups = new Map<string, { members: string[]; clientFiles: Set<string> }>();
    const folded = graph.components.filter(component => !unfolded.has(component.path));
    // Use the file-qualified suffix only when a name is shared within its group.
    const nameCounts = new Map<string, number>();
    for (const component of folded) {
      const key = uiDirectory.exec(component.path)![0] + component.name;
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    for (const component of folded) {
      const directory = uiDirectory.exec(component.path)![0];
      const member = component.id.slice('cmp:'.length + directory.length);
      const prefix = directory.startsWith('src/') ? 'src-ui' : 'ui';
      const props = component.props.length ? `(${component.props.join(',')})` : '';
      const suffix = nameCounts.get(directory + component.name) === 1 ? component.name : member;
      memberIds.set(component.id, `${prefix}:${suffix}`);
      const group = primitiveGroups.get(directory) ?? { members: [], clientFiles: new Set<string>() };
      group.members.push(member + props);
      if (component.isClient) group.clientFiles.add(component.path.slice(directory.length));
      primitiveGroups.set(directory, group);
    }
    const relationships = new Map<string, Record<string, Attribute> & { type: string }>();
    for (const edge of graph.edges) {
      const key = JSON.stringify([edge.from, edge.to]);
      const previous = relationships.get(key);
      const types = new Set(previous?.type.split(' '));
      types.add(edge.type);
      relationships.set(key, {
        from: memberIds.get(edge.from) ?? edge.from,
        to: memberIds.get(edge.to) ?? edge.to,
        type: [...types].join(' ')
      });
    }
    return [
      '# Codebase Architecture Map', '',
      'Read `ui:Name` and `src-ui:Name` as group member IDs. For duplicate names, use `prefix:file#Name`.',
      'Member files are relative to the group directory. `clientFiles` marks `isClient=true`; other member files are false.',
      '', '```xml',
      `<codebase name="${escapeXml(graph.metadata.name)}" framework="nextjs" router="${graph.metadata.router}" language="ts">`,
      section('directories', graph.metadata.directories.map(directory => element('dir', { ...directory }))),
      section('routes', graph.routes.map(route => element('route', {
        id: route.id, path: route.path, scope: route.scope, type: route.type,
        methods: route.methods?.join(' '), wraps: route.wraps?.length ? route.wraps.join(' ') : undefined, component: route.componentId, isClient: route.isClient
      }))),
      section('components', [...graph.components.filter(component => !memberIds.has(component.id)).map(component => element('component', {
        id: component.id, isClient: component.isClient,
        props: component.props.length ? component.props.join(' ') : undefined,
        hooks: component.hooks.length ? component.hooks.join(' ') : undefined
      }, component.description)),
        ...[...primitiveGroups].map(([directory, { members, clientFiles }]) =>
          element('component-group', {
            id: `cmp:${directory.slice(0, -1)}`, count: String(members.length),
            memberPrefix: directory.startsWith('src/') ? 'src-ui:' : 'ui:', members: members.sort().join(' '),
            clientFiles: clientFiles.size ? [...clientFiles].sort().join(' ') : undefined
          }))]),
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
