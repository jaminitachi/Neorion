import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import type { RouteNode } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';

export class RouteAnalyzer {
  private project: Project;
  private appDir: string;

  constructor(project: Project, appDir: string) {
    this.project = project;
    this.appDir = appDir;
  }

  public analyze(): RouteNode[] {
    const routes: RouteNode[] = [];
    const appDirSourceFiles = this.project.getSourceFiles().filter(sf => {
      const filePath = sf.getFilePath();
      return filePath.includes('/app/') && !filePath.includes('node_modules');
    });

    for (const sourceFile of appDirSourceFiles) {
      const filePath = sourceFile.getFilePath();
      const relativePath = path.relative(this.appDir, filePath);
      const fileName = path.basename(filePath);

      if (fileName === 'page.tsx' || fileName === 'layout.tsx' || fileName === 'loading.tsx') {
        const routeNode = this.createRouteNode(sourceFile, relativePath);
        if (routeNode) {
          routes.push(routeNode);
        }
      }
    }

    return routes;
  }

  private createRouteNode(sourceFile: SourceFile, relativePath: string): RouteNode | null {
    const filePath = sourceFile.getFilePath(); // Get full file path here
    const fileName = path.basename(relativePath);
    const dirName = path.dirname(relativePath);
    
    // Calculate URL path from directory structure
    // e.g. app/login/page.tsx -> /login
    // e.g. app/(auth)/login/page.tsx -> /login (ignoring groups)
    let urlPath = '/' + dirName.split(path.sep)
      .filter(part => !part.startsWith('(') && part !== '.')
      .join('/');
    
    if (urlPath === '/.') urlPath = '/'; // Root page

    const type = fileName.replace('.tsx', '') as 'page' | 'layout' | 'loading';
    const id = `route_${dirName.replace(/\//g, '_')}_${type}`.replace(/[\(\)\.]/g, '');
    const isClient = sourceFile.getText().includes('"use client"') || sourceFile.getText().includes("'use client'");

    return {
      id,
      path: urlPath,
      file: relativePath,
      type,
      segment: path.basename(dirName),
      isClient,
      domain: DomainExtractor.extract(filePath)
      // TODO: Extract component name and used hooks
    };
  }
}
