/**
 * Shared Babel utilities for AST parsing and manipulation
 * Used by AnalysisEngine and FileSystemSyncService
 */

import * as parser from '@babel/parser';
import traverseModule, { NodePath } from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';

// Handle ESM default exports
const traverse = (traverseModule as any).default || traverseModule;
const generate = (generateModule as any).default || generateModule;

export { traverse, generate, t };

export interface ParseOptions {
  sourceType?: 'module' | 'script';
  plugins?: parser.ParserPlugin[];
  errorRecovery?: boolean;
}

const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  sourceType: 'module',
  plugins: ['jsx', 'typescript'],
  errorRecovery: true
};

/**
 * Parse source code into an AST
 */
export function parseCode(code: string, options?: ParseOptions): t.File {
  const mergedOptions = { ...DEFAULT_PARSE_OPTIONS, ...options };
  return parser.parse(code, mergedOptions);
}

/**
 * Generate code from an AST
 */
export function generateCode(ast: t.File | t.Node, originalCode?: string): string {
  const result = generate(ast, {}, originalCode);
  return result.code;
}

/**
 * Extract content for an AST node from the original source
 */
export function extractNodeContent(code: string, node: t.Node): string {
  if (node.loc) {
    const lines = code.split('\n');
    const startLine = node.loc.start.line - 1;
    const endLine = node.loc.end.line - 1;
    return lines.slice(startLine, endLine + 1).join('\n');
  }
  return '';
}

/**
 * Check if an AST node is exported (either named or default)
 */
export function isNodeExported(path: NodePath<t.Node>): boolean {
  let currentPath: NodePath | null = path;
  while (currentPath) {
    if (currentPath.parent?.type === 'ExportNamedDeclaration' ||
        currentPath.parent?.type === 'ExportDefaultDeclaration') {
      return true;
    }
    currentPath = currentPath.parentPath;
  }
  return false;
}

/**
 * Extract function calls from an AST path
 */
export function extractFunctionCalls(path: NodePath<t.Node>): string[] {
  const calls: string[] = [];
  path.traverse({
    CallExpression: (callPath: NodePath<t.CallExpression>) => {
      const callee = callPath.node.callee;
      if (callee.type === 'Identifier') {
        calls.push(callee.name);
      } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        calls.push(callee.property.name);
      }
    }
  });
  return [...new Set(calls)];
}

/**
 * Extract variable/type references from an AST path
 */
export function extractReferences(path: NodePath<t.Node>): string[] {
  const refs: string[] = [];
  path.traverse({
    Identifier: (idPath: NodePath<t.Identifier>) => {
      // Skip function parameters and declarations
      if (idPath.parent.type !== 'FunctionDeclaration' && 
          idPath.parent.type !== 'VariableDeclarator') {
        refs.push(idPath.node.name);
      }
    }
  });
  return [...new Set(refs)];
}

/**
 * Get regex patterns to detect element declarations
 */
export function getDeclarationPatterns(name: string, type: 'function' | 'component'): RegExp[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  if (type === 'function') {
    return [
      new RegExp(`function\\s+${escapedName}\\s*\\(`),
      new RegExp(`const\\s+${escapedName}\\s*=\\s*function`),
      new RegExp(`const\\s+${escapedName}\\s*=\\s*\\([^)]*\\)\\s*=>`),
      new RegExp(`const\\s+${escapedName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>`),
      new RegExp(`export\\s+function\\s+${escapedName}\\s*\\(`),
      new RegExp(`export\\s+const\\s+${escapedName}\\s*=`),
      new RegExp(`export\\s+async\\s+function\\s+${escapedName}\\s*\\(`),
      new RegExp(`${escapedName}\\s*:\\s*function`),
      new RegExp(`${escapedName}\\s*:\\s*\\([^)]*\\)\\s*=>`),
    ];
  } else if (type === 'component') {
    return [
      new RegExp(`function\\s+${escapedName}\\s*\\(`),
      new RegExp(`const\\s+${escapedName}\\s*=\\s*\\([^)]*\\)\\s*=>`),
      new RegExp(`class\\s+${escapedName}\\s+extends`),
      new RegExp(`export\\s+function\\s+${escapedName}\\s*\\(`),
      new RegExp(`export\\s+const\\s+${escapedName}\\s*=`),
      new RegExp(`export\\s+default\\s+function\\s+${escapedName}`),
      new RegExp(`export\\s+default\\s+class\\s+${escapedName}`),
    ];
  }
  
  return [];
}

/**
 * Check if an element exists in source code
 */
export function elementExistsInCode(content: string, name: string, type: 'function' | 'component'): boolean {
  const patterns = getDeclarationPatterns(name, type);
  return patterns.some(pattern => pattern.test(content));
}

/**
 * Remove a code element from source using AST
 * Returns the modified code or null if removal failed
 */
export function removeCodeElement(
  code: string, 
  name: string, 
  type: 'function' | 'component'
): string | null {
  try {
    const ast = parseCode(code);
    let removed = false;

    traverse(ast, {
      FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
        if (path.node.id?.name === name) {
          path.remove();
          removed = true;
        }
      },
      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        if (path.node.id.type === 'Identifier' && path.node.id.name === name) {
          const parent = path.parentPath;
          if (parent.isVariableDeclaration()) {
            parent.remove();
            removed = true;
          }
        }
      },
      ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
        if (path.node.id?.name === name) {
          path.remove();
          removed = true;
        }
      },
      ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
        const declaration = path.node.declaration;
        if (declaration) {
          if (declaration.type === 'FunctionDeclaration' && declaration.id?.name === name) {
            path.remove();
            removed = true;
          } else if (declaration.type === 'VariableDeclaration') {
            const declarator = declaration.declarations.find(
              (d: t.VariableDeclarator) => d.id.type === 'Identifier' && d.id.name === name
            );
            if (declarator) {
              path.remove();
              removed = true;
            }
          } else if (declaration.type === 'ClassDeclaration' && declaration.id?.name === name) {
            path.remove();
            removed = true;
          }
        }
      },
      ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
        const declaration = path.node.declaration;
        if (declaration.type === 'FunctionDeclaration' && (declaration as t.FunctionDeclaration).id?.name === name) {
          path.remove();
          removed = true;
        } else if (declaration.type === 'ClassDeclaration' && (declaration as t.ClassDeclaration).id?.name === name) {
          path.remove();
          removed = true;
        }
      }
    });

    if (removed) {
      return generateCode(ast, code);
    }
    return null;
  } catch (error) {
    console.warn(`AST-based removal failed for ${name}:`, error);
    return null;
  }
}

/**
 * Rename a code element in source using AST
 * Returns the modified code or null if rename failed
 */
export function renameCodeElement(
  code: string,
  oldName: string,
  newName: string
): string | null {
  try {
    const ast = parseCode(code);
    let renamed = false;

    traverse(ast, {
      FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
        if (path.node.id?.name === oldName) {
          path.node.id.name = newName;
          renamed = true;
        }
      },
      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        if (path.node.id.type === 'Identifier' && path.node.id.name === oldName) {
          path.node.id.name = newName;
          renamed = true;
        }
      },
      ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
        if (path.node.id?.name === oldName) {
          path.node.id.name = newName;
          renamed = true;
        }
      }
    });

    if (renamed) {
      return generateCode(ast, code);
    }
    return null;
  } catch (error) {
    console.warn(`AST-based rename failed for ${oldName}:`, error);
    return null;
  }
}

/**
 * Extract a code element from source (for move operations)
 * Returns the element code or null if not found
 */
export function extractCodeElementContent(
  code: string,
  name: string,
  type: 'function' | 'component'
): string | null {
  const patterns = getDeclarationPatterns(name, type);
  
  for (const pattern of patterns) {
    const match = pattern.exec(code);
    if (match) {
      const startIndex = match.index;
      let endIndex = startIndex;
      let braceCount = 0;
      let inDeclaration = false;
      
      for (let i = startIndex; i < code.length; i++) {
        const char = code[i];
        if (char === '{') {
          braceCount++;
          inDeclaration = true;
        } else if (char === '}') {
          braceCount--;
          if (inDeclaration && braceCount === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
      
      if (endIndex > startIndex) {
        return code.slice(startIndex, endIndex);
      }
    }
  }
  
  return null;
}

/**
 * Remove a code element using regex fallback
 */
export function removeCodeElementByRegex(
  code: string,
  name: string,
  type: 'function' | 'component'
): string {
  const patterns = getDeclarationPatterns(name, type);
  let updatedContent = code;
  
  for (const pattern of patterns) {
    const match = pattern.exec(updatedContent);
    if (match) {
      const startIndex = match.index;
      let endIndex = startIndex;
      let braceCount = 0;
      let inDeclaration = false;
      
      for (let i = startIndex; i < updatedContent.length; i++) {
        const char = updatedContent[i];
        if (char === '{') {
          braceCount++;
          inDeclaration = true;
        } else if (char === '}') {
          braceCount--;
          if (inDeclaration && braceCount === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
      
      if (endIndex > startIndex) {
        updatedContent = updatedContent.slice(0, startIndex) + updatedContent.slice(endIndex);
        break;
      }
    }
  }
  
  return updatedContent;
}
