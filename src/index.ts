import { Project } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import { RouteAnalyzer } from './analyzers/RouteAnalyzer';
import { ComponentAnalyzer } from './analyzers/ComponentAnalyzer';
import { MarkdownSerializer } from './serializers/MarkdownSerializer';
import type { CodebaseGraph, LibraryInfo } from './types/GraphTypes';

async function main() {
  const projectPath = path.resolve(process.cwd(), '../neo_client');
  const tsConfigPath = path.join(projectPath, 'tsconfig.json');
  const packageJsonPath = path.join(projectPath, 'package.json');

  console.log(`Analyzing project at: ${projectPath}`);

  if (!fs.existsSync(tsConfigPath)) {
    console.error(`tsconfig.json not found at ${tsConfigPath}`);
    process.exit(1);
  }

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
  });

  console.log('Project loaded. Source files:', project.getSourceFiles().length);

  // 1. Analyze Routes
  const appDir = path.join(projectPath, 'app');
  const routeAnalyzer = new RouteAnalyzer(project, appDir);
  const routes = routeAnalyzer.analyze();
  console.log(`Found ${routes.length} routes.`);

  // 2. Analyze Components
  const componentAnalyzer = new ComponentAnalyzer(project);
  const componentFiles = project.getSourceFiles().filter(sf => sf.getFilePath().includes('/components/'));
  const components = componentFiles.flatMap(sf => componentAnalyzer.analyzeFile(sf));
  console.log(`Found ${components.length} components.`);

  // 3. Analyze Dependencies (from package.json)
  let libraries: LibraryInfo[] = [];
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    libraries = Object.entries(deps).map(([name, version]) => ({
      name,
      version: version as string,
      role: 'dependency' // TODO: Refine role based on known libraries
    }));
  }

  // 4. Construct Graph
  const graph: CodebaseGraph = {
    metadata: {
      name: 'neo_client',
      framework: 'nextjs',
      router: 'app',
      language: 'ts',
      directories: [
        { path: 'app', role: 'routes' },
        { path: 'components', role: 'ui_components' },
        { path: 'hooks', role: 'react_hooks' },
        { path: 'lib', role: 'utils' }
      ]
    },
    routes,
    components,
    hooks: [], // TODO: Implement Hook Analyzer
    libraries
  };

  // 5. Serialize
  const serializer = new MarkdownSerializer();
  const output = serializer.serialize(graph);

  fs.writeFileSync('codebase_graph.md', output);
  console.log('Graph generated at codebase_graph.md');
}

main().catch(console.error);
