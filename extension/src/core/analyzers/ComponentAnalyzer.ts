import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import type { ComponentNode, ComponentProp, ImportInfo } from '../types/GraphTypes';
import * as path from 'path';
import { DomainExtractor } from '../utils/DomainExtractor';

export class ComponentAnalyzer {
  private project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  public analyzeFile(sourceFile: SourceFile): ComponentNode[] {
    const components: ComponentNode[] = [];
    const filePath = sourceFile.getFilePath();
    
    // Find function declarations or variable declarations that look like components
    const functions = sourceFile.getFunctions();
    const variables = sourceFile.getVariableDeclarations();

    // Helper to check if a node is a component
    const isComponent = (name: string) => /^[A-Z]/.test(name);

    functions.forEach(func => {
      const name = func.getName();
      if (name && isComponent(name)) { // Simple heuristic: starts with Uppercase
        // Check if it returns JSX (omitted for speed, assuming naming convention)
        components.push(this.createComponentNode(name, sourceFile, func));
      }
    });

    variables.forEach(variable => {
      const name = variable.getName();
      if (name && isComponent(name)) {
        const initializer = variable.getInitializer();
        if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
           components.push(this.createComponentNode(name, sourceFile, variable));
        }
      }
    });

    return components;
  }

  private createComponentNode(name: string, sourceFile: SourceFile, node: Node): ComponentNode {
    const filePath = sourceFile.getFilePath();
    const relativePath = path.relative(this.project.getFileSystem().getCurrentDirectory(), filePath);
    const id = `cmp_${name}`;
    const isClient = sourceFile.getText().includes('"use client"') || sourceFile.getText().includes("'use client'");
    
    // Extract Imports
    const imports: ImportInfo[] = sourceFile.getImportDeclarations().map(imp => {
      return {
        name: imp.getDefaultImport()?.getText() || imp.getNamedImports().map(ni => ni.getName()).join(', '),
        from: imp.getModuleSpecifierValue(),
        isExternal: !imp.getModuleSpecifierValue().startsWith('.')
      };
    });

    // 1. Extract Props (Signature Analysis)
    const props: ComponentProp[] = []; 
    const funcText = node.getText();
    // Improved Prop Extraction leveraging ts-morph if possible, or robust regex fallback
    const propMatch = funcText.match(/function\s+\w+\s*\(\s*\{([^}]+)\}/) || funcText.match(/const\s+\w+\s*=\s*\(\s*\{([^}]+)\}/);
    if (propMatch) {
       const propKeys = propMatch[1].split(',').map(s => s.trim().split(/[=:]/)[0].trim()).filter(s => s && !s.startsWith('//'));
       propKeys.slice(0, 15).forEach(key => props.push({ name: key, type: 'any', required: true })); 
    }

    // 2. Extract State Skeletons (useState, useReducer)
    const stateVariables: string[] = [];
    node.forEachDescendant(descendant => {
        if (Node.isCallExpression(descendant)) {
            const expr = descendant.getExpression();
            if (Node.isIdentifier(expr) && (expr.getText() === 'useState' || expr.getText() === 'useReducer')) {
                const parent = descendant.getParent();
                if (Node.isVariableDeclaration(parent)) {
                    const nameNode = parent.getNameNode();
                    if (Node.isArrayBindingPattern(nameNode)) {
                        const elements = nameNode.getElements();
                        if (elements.length > 0) {
                            stateVariables.push(elements[0].getText()); // Catch 'user' from [user, setUser]
                        }
                    }
                }
            }
        }
    });

    // 3. Extract Side Effect Skeletons (useEffect Dependencies)
    const sideEffects: string[] = [];
    node.forEachDescendant(descendant => {
        if (Node.isCallExpression(descendant)) {
            const expr = descendant.getExpression();
             if (Node.isIdentifier(expr) && expr.getText() === 'useEffect') {
                const args = descendant.getArguments();
                if (args.length > 1) {
                    const deps = args[1];
                     if (Node.isArrayLiteralExpression(deps)) {
                        const depStrings = deps.getElements().map(e => e.getText()).join(', ');
                        sideEffects.push(`[${depStrings}]`);
                    } else {
                        sideEffects.push('(Dynamic Deps)');
                    }
                } else if (args.length === 1) {
                    sideEffects.push('(Every Render)');
                }
             }
        }
    });

    // 4. Extract Hook Usage Skeletons (Custom Hooks + Args)
    const hooks: string[] = [];
    node.forEachDescendant(descendant => {
        if (Node.isCallExpression(descendant)) {
            const expr = descendant.getExpression();
            if (Node.isIdentifier(expr)) {
                const callName = expr.getText();
                if (callName.startsWith('use') && callName !== 'useState' && callName !== 'useEffect' && callName !== 'useReducer') {
                    // Capture hook name 
                    hooks.push(callName);
                }
            }
        }
    });

    // 5. Synthesize Semantic Description (The "Skeleton")
    const skeletonParts = [];
    if (stateVariables.length > 0) skeletonParts.push(`State: { ${stateVariables.slice(0, 5).join(', ')}${stateVariables.length > 5 ? '...' : ''} }`);
    if (sideEffects.length > 0) skeletonParts.push(`Effects: ${sideEffects.length} detected`); // Detailed effect logic often too long, count is enough signal
    if (hooks.length > 0) skeletonParts.push(`Uses: ${[...new Set(hooks)].join(', ')}`);

    let description = '';
    // JSDoc priority
    if (Node.isJSDocable(node)) {
        const jsDocs = node.getJsDocs();
        if (jsDocs.length > 0) description = jsDocs[0].getDescription().trim();
    }
    if (!description && Node.isVariableDeclaration(node)) {
         const variableStatement = node.getParent()?.getParent();
         if (Node.isVariableStatement(variableStatement)) {
             const jsDocs = variableStatement.getJsDocs();
             if (jsDocs.length > 0) description = jsDocs[0].getDescription().trim();
         }
    }

    const enhancedDescription = description 
        ? `${description} | [meta] ${skeletonParts.join(', ')}` 
        : `[Skeleton] ${skeletonParts.join(' | ') || 'Stateless UI'}`;

    return {
      id,
      name,
      description: enhancedDescription, 
      path: filePath,
      kind: 'ui', 
      isClient,
      domain: DomainExtractor.extract(filePath),
      props,
      imports,
      hooks: [...new Set(hooks)],
      renders: [] 
    };
  }
}
