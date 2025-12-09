import type { CodebaseGraph, RouteNode, ComponentNode, HookNode, LibraryInfo } from '../types/GraphTypes';

export class MarkdownSerializer {
  public serialize(graph: CodebaseGraph): string {
    return `# Codebase Architecture Map

\`\`\`xml
<codebase name="${graph.metadata.name}" framework="${graph.metadata.framework}" router="${graph.metadata.router}" language="${graph.metadata.language}">
  <directories>
${graph.metadata.directories.map(d => `    <dir path="${d.path}" role="${d.role}" />`).join('\n')}
  </directories>

  <routes>
${graph.routes.map(r => this.serializeRoute(r)).join('\n')}
  </routes>

  <components>
${graph.components.map(c => this.serializeComponent(c)).join('\n')}
  </components>

  <hooks>
${graph.hooks.map(h => this.serializeHook(h)).join('\n')}
  </hooks>

  <dependencies>
${graph.libraries.map(l => `    <lib name="${l.name}" version="${l.version}" role="${l.role}" />`).join('\n')}
  </dependencies>
</codebase>
\`\`\`
`;
  }

  private serializeRoute(route: RouteNode): string {
    const attrs = [
      `id="${route.id}"`,
      `path="${route.path}"`,
      `file="${route.file}"`,
      `type="${route.type}"`,
      `segment="${route.segment}"`,
      `isClient="${route.isClient}"`
    ].join(' ');

    return `    <route ${attrs} />`;
  }

  private serializeComponent(component: ComponentNode): string {
    const attrs = [
      `id="${component.id}"`,
      `name="${component.name}"`,
      `path="${component.path}"`,
      `kind="${component.kind}"`,
      `isClient="${component.isClient}"`
    ].join(' ');

    const props = component.props.length > 0
      ? `\n      <props>\n${component.props.map(p => `        <prop name="${p.name}" type="${this.escapeXml(p.type)}" required="${p.required}" />`).join('\n')}\n      </props>`
      : '';

    const imports = component.imports.length > 0
      ? `\n      <imports>\n${component.imports.map(i => `        <import name="${i.name}" from="${i.from}" />`).join('\n')}\n      </imports>`
      : '';
    
    const hooks = component.hooks.length > 0
        ? `\n      <usesHooks>\n${component.hooks.map(h => `        <hook name="${h}" />`).join('\n')}\n      </usesHooks>`
        : '';

    const description = component.description 
        ? `\n      <description>${this.escapeXml(component.description)}</description>` 
        : '';
    
    // DEBUG: Trace missing descriptions
    if (!component.description) {
        console.log(`[NEORION DEBUG] Component ${component.name} has NO description!`);
    } else {
        console.log(`[NEORION DEBUG] Component ${component.name} description len: ${component.description.length}`);
    }

    if (!description && !props && !imports && !hooks) {
      return `    <component ${attrs} />`;
    }

    return `    <component ${attrs}>${description}${props}${imports}${hooks}\n    </component>`;
  }

  private serializeHook(hook: HookNode): string {
    return `    <hook id="${hook.id}" name="${hook.name}" path="${hook.path}" />`;
  }

  private escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }
}
