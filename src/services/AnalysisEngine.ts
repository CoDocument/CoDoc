/**
 * Unified AnalysisEngine for codebase scanning and CODOC construction
 * Extracts code structure with dependency tracking
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  CodebaseSnapshot,
  FileStructure,
  CodeElement,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  SchemaNode,
  ImportInfo
} from '../types.js';
import * as crypto from 'crypto';
import {
  parseCode,
  traverse,
  extractNodeContent,
  isNodeExported,
  extractFunctionCalls,
  extractReferences
} from './BabelUtils.js';

export class AnalysisEngine {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Scan codebase and build snapshot with dependencies
   */
  async scanCodebase(): Promise<CodebaseSnapshot> {
    const snapshot: CodebaseSnapshot = {
      files: [],
      directories: [],
      timestamp: Date.now(),
      workspaceRoot: this.workspaceRoot,
      dependencyGraph: { nodes: {}, edges: [] }
    };

    // Find all files in src directory
    const filePatterns = [
      'src/**/*.{ts,tsx,js,jsx}',
      'src/**/*.{py,java,cpp,c,go,rs,rb,php}'
    ];

    const excludePatterns = [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.d.ts',
      '**/setupTests.*',
      '**/reportWebVitals.*',
      '**/*-env.d.ts'
    ];

    const allFiles: vscode.Uri[] = [];
    for (const pattern of filePatterns) {
      const files = await vscode.workspace.findFiles(
        pattern,
        `{${excludePatterns.join(',')}}`
      );
      allFiles.push(...files);
    }

    allFiles.sort((a, b) =>
      a.fsPath.localeCompare(b.fsPath, undefined, { sensitivity: 'base' })
    );

    // Analyze each file
    for (const fileUri of allFiles) {
      try {
        const fileStructure = await this.analyzeFile(fileUri);
        if (fileStructure) {
          snapshot.files.push(fileStructure);
        }
      } catch (error) {
        console.warn(`Failed to analyze ${fileUri.fsPath}:`, error);
      }
    }

    snapshot.files.sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
    );

    // Build dependency graph
    snapshot.dependencyGraph = this.buildDependencyGraph(snapshot.files);

    // Extract directories (including empty ones)
    snapshot.directories = await this.extractAllDirectories(snapshot.files);

    return snapshot;
  }

  /**
   * Analyze single file and extract structure with dependencies
   */
  private async analyzeFile(fileUri: vscode.Uri): Promise<FileStructure | null> {
    try {
      const relativePath = path.relative(this.workspaceRoot, fileUri.fsPath);
      const stats = await vscode.workspace.fs.stat(fileUri);
      const content = await vscode.workspace.fs.readFile(fileUri);
      const code = new TextDecoder().decode(content);

      const fileStructure: FileStructure = {
        path: relativePath,
        exists: true,
        language: this.detectLanguage(relativePath),
        elements: [],
        contentHash: this.calculateHash(code),
        lastModified: stats.mtime,
        size: stats.size,
        imports: []
      };

      // Extract code elements and imports with dependencies
      if (this.isCodeFile(relativePath)) {
        const { elements, imports } = await this.extractCodeElementsWithImports(code, relativePath);
        fileStructure.elements = elements;
        fileStructure.imports = imports;
      }

      return fileStructure;
    } catch (error) {
      console.warn(`Error analyzing file ${fileUri.fsPath}:`, error);
      return null;
    }
  }

  /**
   * Extract code elements and file-level imports using Babel
   */
  private async extractCodeElementsWithImports(
    code: string,
    filePath: string
  ): Promise<{ elements: CodeElement[]; imports: ImportInfo[] }> {
    const elements: CodeElement[] = [];
    const imports: ImportInfo[] = [];

    try {
      const ast = parseCode(code);

      // Track imports at file level (paths only for element tracking)
      const fileImportPaths: string[] = [];

      traverse(ast, {
        // Track imports - extract detailed import info
        ImportDeclaration: (nodePath: NodePath<t.ImportDeclaration>) => {
          const source = nodePath.node.source.value;
          fileImportPaths.push(source);

          const specifiers: string[] = [];
          let isDefault = false;
          let isNamespace = false;

          for (const specifier of nodePath.node.specifiers) {
            if (specifier.type === 'ImportDefaultSpecifier') {
              specifiers.push(specifier.local.name);
              isDefault = true;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              specifiers.push(specifier.local.name);
              isNamespace = true;
            } else if (specifier.type === 'ImportSpecifier') {
              // For named imports, track both imported and local names
              const imported = specifier.imported;
              const importedName = imported.type === 'Identifier' ? imported.name : imported.value;
              specifiers.push(importedName);
            }
          }

          imports.push({
            source,
            specifiers,
            isDefault,
            isNamespace,
            line: nodePath.node.loc?.start.line ?? 1
          });
        },

        // Function declarations
        FunctionDeclaration: (nodePath: NodePath<t.FunctionDeclaration>) => {
          const name = nodePath.node.id?.name;
          if (!name) return;

          const isComponent = /^[A-Z]/.test(name);
          const isExported = isNodeExported(nodePath);

          const element: CodeElement = {
            name,
            type: isComponent ? 'component' : 'function',
            filePath,
            line: nodePath.node.loc?.start.line ?? 1,
            column: nodePath.node.loc?.start.column ?? 0,
            isExported,
            content: extractNodeContent(code, nodePath.node),
            imports: [...fileImportPaths],
            exports: isExported ? [name] : [],
            calls: extractFunctionCalls(nodePath),
            references: extractReferences(nodePath)
          };

          elements.push(element);
        },

        // Arrow functions and components
        VariableDeclarator: (nodePath: NodePath<t.VariableDeclarator>) => {
          const id = nodePath.node.id;
          const init = nodePath.node.init;
          const name = (id as any)?.name;

          if (!name || !init) return;

          if (
            init.type === 'ArrowFunctionExpression' ||
            init.type === 'FunctionExpression'
          ) {
            const isComponent = /^[A-Z]/.test(name);
            const isExported = isNodeExported(nodePath);

            const element: CodeElement = {
              name,
              type: isComponent ? 'component' : 'function',
              filePath,
              line: nodePath.node.loc?.start.line ?? 1,
              column: nodePath.node.loc?.start.column ?? 0,
              isExported,
              content: extractNodeContent(code, nodePath.node),
              imports: [...fileImportPaths],
              exports: isExported ? [name] : [],
              calls: extractFunctionCalls(nodePath),
              references: extractReferences(nodePath)
            };

            elements.push(element);
          }
          // Skip non-function variables - we don't track them in CoDoc
        },

        // Classes
        ClassDeclaration: (nodePath: NodePath<t.ClassDeclaration>) => {
          const name = nodePath.node.id?.name;
          if (!name) return;

          const isExported = isNodeExported(nodePath);

          const element: CodeElement = {
            name,
            type: 'class',
            filePath,
            line: nodePath.node.loc?.start.line ?? 1,
            column: nodePath.node.loc?.start.column ?? 0,
            isExported,
            content: extractNodeContent(code, nodePath.node),
            imports: [...fileImportPaths],
            exports: isExported ? [name] : [],
            calls: [],
            references: []
          };

          elements.push(element);
        }
      });
    } catch (error) {
      console.warn(`Failed to extract elements from ${filePath}:`, error);
    }

    return { elements, imports };
  }

  /**
   * Build dependency graph from file structures
   */
  private buildDependencyGraph(files: FileStructure[]): DependencyGraph {
    const nodes = new Map<string, DependencyNode>();
    const edges: DependencyEdge[] = [];

    // Step 1: Create directory nodes
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.path.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        directories.add(dirPath);
      }
    }

    for (const dirPath of directories) {
      const dirName = dirPath.split('/').pop() || dirPath;
      nodes.set(dirPath, {
        id: dirPath,
        name: dirName,
        type: 'directory',
        filePath: dirPath,
        upstream: [],
        downstream: []
      });
    }

    // Step 2: Create file nodes
    for (const file of files) {
      nodes.set(file.path, {
        id: file.path,
        name: file.path.split('/').pop() || file.path,
        type: 'file',
        filePath: file.path,
        upstream: [],
        downstream: []
      });
    }

    // Step 3: Create element nodes (functions, components, classes)
    for (const file of files) {
      for (const element of file.elements) {
        const nodeId = `${file.path}:${element.name}`;
        nodes.set(nodeId, {
          id: nodeId,
          name: element.name,
          type: element.type as any,
          filePath: file.path,
          upstream: [],
          downstream: []
        });
      }
    }

    // Step 4: Build hierarchical relationships (directory -> file -> element)
    for (const file of files) {
      const fileNode = nodes.get(file.path);
      if (!fileNode) continue;

      // Connect directory to file
      const parts = file.path.split('/');
      if (parts.length > 1) {
        const parentDir = parts.slice(0, -1).join('/');
        const parentNode = nodes.get(parentDir);
        if (parentNode) {
          edges.push({
            from: parentDir,
            to: file.path,
            type: 'contains',
            location: { file: file.path, line: 0 }
          });
          parentNode.downstream.push(file.path);
          fileNode.upstream.push(parentDir);
        }
      }

      // Connect file to its elements
      for (const element of file.elements) {
        const elementId = `${file.path}:${element.name}`;
        const elementNode = nodes.get(elementId);
        if (elementNode) {
          edges.push({
            from: file.path,
            to: elementId,
            type: 'contains',
            location: { file: file.path, line: element.line }
          });
          fileNode.downstream.push(elementId);
          elementNode.upstream.push(file.path);
        }
      }
    }

    // Step 5: Build file-to-file import dependencies
    for (const file of files) {
      const fileNode = nodes.get(file.path);
      if (!fileNode || !file.imports) continue;

      for (const importInfo of file.imports) {
        // Resolve the import to an actual file
        const targetFile = this.resolveImportPath(importInfo.source, file.path, files);
        if (targetFile && nodes.has(targetFile)) {
          const targetFileNode = nodes.get(targetFile)!;
          
          // Create file-to-file import edge
          const edgeExists = edges.some(e => 
            e.from === file.path && e.to === targetFile && e.type === 'import'
          );
          
          if (!edgeExists) {
            edges.push({
              from: file.path,
              to: targetFile,
              type: 'import',
              location: { file: file.path, line: importInfo.line }
            });
            
            // Track dependencies (this file depends on targetFile)
            if (!fileNode.upstream.includes(targetFile)) {
              fileNode.upstream.push(targetFile);
            }
            if (!targetFileNode.downstream.includes(file.path)) {
              targetFileNode.downstream.push(file.path);
            }
          }

          // Also create element-to-element dependencies for specific imports
          for (const specifier of importInfo.specifiers) {
            // Find the exported element in target file
            const targetFileStructure = files.find(f => f.path === targetFile);
            if (targetFileStructure) {
              const targetElement = targetFileStructure.elements.find(
                e => e.name === specifier && e.isExported
              );
              if (targetElement) {
                const targetElementId = `${targetFile}:${specifier}`;
                
                // Link importing file's elements that use this specifier
                for (const element of file.elements) {
                  const fromId = `${file.path}:${element.name}`;
                  const fromNode = nodes.get(fromId);
                  
                  // Check if this element references the imported specifier
                  if (fromNode && (element.references.includes(specifier) || element.calls.includes(specifier))) {
                    const elementEdgeExists = edges.some(e => 
                      e.from === fromId && e.to === targetElementId && e.type === 'import'
                    );
                    
                    if (!elementEdgeExists && nodes.has(targetElementId)) {
                      edges.push({
                        from: fromId,
                        to: targetElementId,
                        type: 'import',
                        location: { file: file.path, line: element.line }
                      });
                      fromNode.upstream.push(targetElementId);
                      nodes.get(targetElementId)!.downstream.push(fromId);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Step 6: Build edges based on function calls within same file
    for (const file of files) {
      for (const element of file.elements) {
        const fromId = `${file.path}:${element.name}`;
        const fromNode = nodes.get(fromId);
        if (!fromNode) continue;

        // Process function calls
        for (const call of element.calls) {
          // Find target in same file first
          const targetId = this.resolveReference(call, file.path, element.imports, files);
          if (targetId && nodes.has(targetId) && targetId !== fromId) {
            const callEdgeExists = edges.some(e => 
              e.from === fromId && e.to === targetId && e.type === 'call'
            );
            
            if (!callEdgeExists) {
              edges.push({
                from: fromId,
                to: targetId,
                type: 'call',
                location: { file: file.path, line: element.line }
              });
              if (!fromNode.upstream.includes(targetId)) {
                fromNode.upstream.push(targetId);
              }
              if (!nodes.get(targetId)!.downstream.includes(fromId)) {
                nodes.get(targetId)!.downstream.push(fromId);
              }
            }
          }
        }
      }
    }

    // Convert Map to plain object for JSON serialization
    const nodesObject: Record<string, DependencyNode> = {};
    for (const [key, value] of nodes.entries()) {
      nodesObject[key] = value;
    }

    return { nodes: nodesObject, edges };
  }

  /**
   * Resolve reference to node ID
   */
  private resolveReference(
    reference: string,
    currentFile: string,
    imports: string[],
    files: FileStructure[]
  ): string | null {
    // First check same file
    const currentFileStructure = files.find(f => f.path === currentFile);
    if (currentFileStructure) {
      const element = currentFileStructure.elements.find(e => e.name === reference);
      if (element) {
        return `${currentFile}:${reference}`;
      }
    }

    // Check imported files
    for (const imp of imports) {
      const targetFile = this.resolveImportPath(imp, currentFile, files);
      if (targetFile) {
        const targetFileStructure = files.find(f => f.path === targetFile);
        if (targetFileStructure) {
          const element = targetFileStructure.elements.find(
            e => e.name === reference && e.isExported
          );
          if (element) {
            return `${targetFile}:${reference}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve import path to actual file
   */
  private resolveImportPath(
    importPath: string,
    currentFile: string,
    files: FileStructure[]
  ): string | null {
    // Skip node_modules
    if (!importPath.startsWith('.')) {
      return null;
    }

    const currentDir = path.dirname(currentFile);
    const resolved = path.normalize(path.join(currentDir, importPath));

    // Try with different extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.index.ts', '.index.tsx'];
    for (const ext of extensions) {
      const candidate = files.find(f =>
        f.path === resolved + ext ||
        f.path === path.join(resolved, `index${ext}`)
      );
      if (candidate) {
        return candidate.path;
      }
    }

    return null;
  }

  /**
   * Extract directory list from files and scan for empty directories
   */
  private async extractAllDirectories(files: FileStructure[]): Promise<string[]> {
    const dirs = new Set<string>();
    
    // Add directories derived from file paths
    for (const file of files) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
    
    // Scan filesystem for all directories including empty ones
    try {
      const dirPattern = 'src/**';
      const excludePatterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**'
      ];
      
      const allItems = await vscode.workspace.findFiles(
        dirPattern,
        `{${excludePatterns.join(',')}}`
      );
      
      // Extract directory paths from all found items
      for (const item of allItems) {
        const relativePath = path.relative(this.workspaceRoot, item.fsPath);
        const dirPath = path.dirname(relativePath);
        
        if (dirPath && dirPath !== '.' && dirPath.startsWith('src')) {
          const parts = dirPath.split('/');
          for (let i = 1; i <= parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
          }
        }
      }
      
      // Also scan for directories directly using readDirectory
      await this.scanDirectoriesRecursive('src', dirs);
    } catch (error) {
      console.warn('Failed to scan directories:', error);
    }
    
    return Array.from(dirs).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }
  
  /**
   * Recursively scan directories to find all folders including empty ones
   */
  private async scanDirectoriesRecursive(dirPath: string, dirs: Set<string>): Promise<void> {
    try {
      const fullPath = path.join(this.workspaceRoot, dirPath);
      const dirUri = vscode.Uri.file(fullPath);
      
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      
      for (const [name, type] of entries) {
        // Skip excluded directories
        if (name === 'node_modules' || name === 'dist' || name === 'build' || name === 'out') {
          continue;
        }
        
        if (type === vscode.FileType.Directory) {
          const subDirPath = path.join(dirPath, name).replace(/\\/g, '/');
          dirs.add(subDirPath);
          
          // Recursively scan subdirectories
          await this.scanDirectoriesRecursive(subDirPath, dirs);
        }
      }
    } catch (error) {
      // Directory might not exist or not accessible
      console.debug(`Could not scan directory ${dirPath}:`, error);
    }
  }

  /**
   * Build CODOC structure from snapshot
   * Now also assigns correct line numbers based on tree traversal order
   */
  constructCodoc(snapshot: CodebaseSnapshot, existingComments?: SchemaNode[]): SchemaNode[] {
    const root: SchemaNode = {
      id: 'root',
      type: 'directory',
      name: '',
      path: '',
      lineNumber: 0,
      column: 0,
      dependencies: [],
      dependents: [],
      contentHash: '',
      children: []
    };

    // Build hierarchical structure from files
    for (const file of snapshot.files) {
      this.addFileToTree(root, file, snapshot.dependencyGraph);
    }
    
    // Add empty directories that don't have any files
    for (const dir of snapshot.directories) {
      this.ensureDirectoryExists(root, dir);
    }

    // Preserve existing comments by re-inserting them at their original positions
    if (existingComments && existingComments.length > 0) {
      this.reinsertComments(root, existingComments);
    }

    // Sort nodes to match VS Code explorer ordering before assigning line numbers
    this.sortSchemaNodes(root.children);

    // Assign line numbers based on serialization order
    this.assignLineNumbers(root.children || [], 1);

    return root.children || [];
  }

  /**
   * Ensure a directory path exists in the tree, creating it if necessary
   */
  private ensureDirectoryExists(root: SchemaNode, dirPath: string): void {
    const pathParts = dirPath.split('/').filter(p => p.length > 0);
    let current = root;
    
    for (let i = 0; i < pathParts.length; i++) {
      const dirName = pathParts[i];
      let dirNode = current.children?.find(c => c.name === dirName && c.type === 'directory');
      
      if (!dirNode) {
        // Create the directory node
        dirNode = {
          id: `dir_${pathParts.slice(0, i + 1).join('_')}`,
          type: 'directory',
          name: dirName,
          path: pathParts.slice(0, i + 1).join('/'),
          lineNumber: 0,
          column: (i + 1) * 2,
          dependencies: [],
          dependents: [],
          contentHash: '',
          children: []
        };
        
        if (!current.children) {
          current.children = [];
        }
        current.children.push(dirNode);
      }
      
      current = dirNode;
    }
  }

  /**
   * Reinsert comments at their original positions in the tree
   * Comments are matched by their path context (parent path)
   */
  private reinsertComments(root: SchemaNode, comments: SchemaNode[]): void {
    console.log('[AnalysisEngine] Reinserting', comments.length, 'comments');
    
    // First, check if any comments already exist in the tree (to avoid duplication)
    const existingComments = this.extractAllComments(root);
    const existingCommentKeys = new Set(
      existingComments.map(c => `${c.content || c.name}-${c.lineNumber}`)
    );
    
    for (const comment of comments) {
      if (!comment.isComment) continue;
      
      // Skip if this comment already exists in the tree
      const commentKey = `${comment.content || comment.name}-${comment.lineNumber}`;
      if (existingCommentKeys.has(commentKey)) {
        console.log('[AnalysisEngine] Skipping duplicate comment:', comment.content || comment.name);
        continue;
      }
      
      // Determine where to reinsert based on comment's parent path
      const targetNode = this.findNodeForCommentInsertion(root, comment);
      
      if (targetNode) {
        if (!targetNode.children) {
          targetNode.children = [];
        }
        
        // Create a fresh comment node (to avoid reference issues)
        // Explicitly omit parent to avoid circular references
        const { parent, children, ...commentData } = comment;
        const freshComment: SchemaNode = {
          ...commentData,
          lineNumber: 0, // Will be recalculated
          children: undefined // Comments shouldn't have children
        };
        
        targetNode.children.push(freshComment);
      } else {
        // If no parent found, add to root level
        if (!root.children) {
          root.children = [];
        }
        const { parent, children, ...commentData } = comment;
        const freshComment: SchemaNode = {
          ...commentData,
          lineNumber: 0,
          children: undefined
        };
        root.children.push(freshComment);
      }
    }
  }

  /**
   * Extract all comments from a tree (used to check for duplicates)
   */
  private extractAllComments(node: SchemaNode): SchemaNode[] {
    const comments: SchemaNode[] = [];
    
    if (node.isComment) {
      comments.push(node);
    }
    
    if (node.children) {
      for (const child of node.children) {
        comments.push(...this.extractAllComments(child));
      }
    }
    
    return comments;
  }

  /**
   * Find the appropriate node to insert a comment
   * Uses parent path from the comment's original location
   */
  private findNodeForCommentInsertion(root: SchemaNode, comment: SchemaNode): SchemaNode | null {
    // If comment had a parent, try to find it by path
    if (comment.parent) {
      const parentPath = comment.parent.path;
      return this.findNodeByPath(root, parentPath);
    }
    return root;
  }

  /**
   * Find a node by its path in the tree
   */
  private findNodeByPath(root: SchemaNode, path: string): SchemaNode | null {
    if (root.path === path) {
      return root;
    }
    
    if (root.children) {
      for (const child of root.children) {
        const found = this.findNodeByPath(child, path);
        if (found) return found;
      }
    }
    
    return null;
  }
  
  /**
   * Recursively assign line numbers to nodes based on their position in serialized CoDoc
   * This ensures parser line numbers match the actual CoDoc text structure
   */
  private assignLineNumbers(nodes: SchemaNode[], startLine: number): number {
    let currentLine = startLine;
    
    for (const node of nodes) {
      node.lineNumber = currentLine++;
      
      if (node.children && node.children.length > 0) {
        currentLine = this.assignLineNumbers(node.children, currentLine);
      }
    }
    
    return currentLine;
  }

  /**
   * Sort schema nodes to match VS Code explorer ordering (directories first, alphabetical)
   * Comments are kept in their relative positions
   */
  private sortSchemaNodes(nodes?: SchemaNode[]): void {
    if (!nodes || nodes.length === 0) {
      return;
    }

    // Separate comments from other nodes
    const comments: SchemaNode[] = [];
    const nonComments: SchemaNode[] = [];
    
    for (const node of nodes) {
      if (node.isComment) {
        comments.push(node);
      } else {
        nonComments.push(node);
      }
    }

    // Sort non-comment nodes
    nonComments.sort((a, b) => this.compareSchemaNodes(a, b));

    // Merge back: interleave comments at their relative positions
    // Comments should stay near their original neighboring nodes
    nodes.length = 0;
    
    // If we have comments with position info, try to preserve their relative positions
    if (comments.length > 0 && comments[0].lineNumber !== undefined) {
      let commentIndex = 0;
      let nodeIndex = 0;
      
      while (nodeIndex < nonComments.length || commentIndex < comments.length) {
        if (commentIndex >= comments.length) {
          nodes.push(nonComments[nodeIndex++]);
        } else if (nodeIndex >= nonComments.length) {
          nodes.push(comments[commentIndex++]);
        } else {
          // Place comment before or after node based on original line numbers
          const comment = comments[commentIndex];
          const node = nonComments[nodeIndex];
          
          // If comment was originally before this node, insert it first
          if (comment.lineNumber < node.lineNumber) {
            nodes.push(comments[commentIndex++]);
          } else {
            nodes.push(nonComments[nodeIndex++]);
          }
        }
      }
    } else {
      // Fallback: if no line numbers, just append comments at the end
      nodes.push(...nonComments, ...comments);
    }

    // Recursively sort children (non-file nodes)
    for (const node of nodes) {
      if (node.type !== 'file' && node.children && node.children.length > 0) {
        this.sortSchemaNodes(node.children);
      }
    }
  }

  private compareSchemaNodes(a: SchemaNode, b: SchemaNode): number {
    const weightDiff = this.getNodeSortWeight(a) - this.getNodeSortWeight(b);
    if (weightDiff !== 0) {
      return weightDiff;
    }

    const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return (a.path || '').localeCompare(b.path || '', undefined, { sensitivity: 'base' });
  }

  private getNodeSortWeight(node: SchemaNode): number {
    switch (node.type) {
      case 'directory':
        return 0;
      case 'file':
        return 1;
      default:
        return 2;
    }
  }

  /**
   * Add file to tree structure
   */
  private addFileToTree(
    root: SchemaNode,
    file: FileStructure,
    graph: DependencyGraph
  ): void {
    const pathParts = file.path.split('/').filter(p => p.length > 0);
    let current = root;

    // Navigate/create directory structure
    for (let i = 0; i < pathParts.length - 1; i++) {
      const dirName = pathParts[i];
      let dirNode = current.children?.find(c => c.name === dirName && c.type === 'directory');

      if (!dirNode) {
        dirNode = {
          id: `dir_${pathParts.slice(0, i + 1).join('_')}`,
          type: 'directory',
          name: dirName,
          path: pathParts.slice(0, i + 1).join('/'),
          lineNumber: 0,
          column: (i + 1) * 2,
          dependencies: [],
          dependents: [],
          contentHash: '',
          children: []
        };
        if (!current.children) current.children = [];
        current.children.push(dirNode);
      }

      current = dirNode;
    }

    // Add file node
    const fileName = pathParts[pathParts.length - 1];
    const fileNode: SchemaNode = {
      id: `file_${file.path.replace(/[\/\.]/g, '_')}`,
      type: 'file',
      name: fileName,
      path: file.path,
      extension: path.extname(fileName),
      lineNumber: 0,
      column: pathParts.length * 2,
      dependencies: [],
      dependents: [],
      contentHash: file.contentHash,
      children: []
    };

    // Add elements as children
    for (const element of file.elements) {
      const nodeId = `${file.path}:${element.name}`;
      const depNode = graph.nodes[nodeId];

      // Map element types to schema node types
      let nodeType: SchemaNode['type'];
      if (element.type === 'class' || element.type === 'interface' || element.type === 'type') {
        nodeType = 'component';
      } else {
        nodeType = element.type;
      }

      const elementNode: SchemaNode = {
        id: nodeId,
        type: nodeType,
        name: element.name,
        path: `${file.path}#${element.name}`,
        lineNumber: element.line,
        column: (pathParts.length + 1) * 2,
        dependencies: depNode?.upstream || [],
        dependents: depNode?.downstream || [],
        contentHash: this.calculateHash(element.content),
        isExported: element.isExported
      };

      if (element.type === 'function') {
        elementNode.functionSignature = `$${element.name}()`;
      }

      fileNode.children!.push(elementNode);
    }

    if (!current.children) current.children = [];
    current.children.push(fileNode);
  }

  /**
   * Detect language from file path
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    const langMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php'
    };
    return langMap[ext] || 'plaintext';
  }

  /**
   * Check if file should be analyzed for code
   */
  private isCodeFile(filePath: string): boolean {
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.go', '.rs'];
    return codeExtensions.some(ext => filePath.endsWith(ext));
  }

  /**
   * Calculate SHA-256 hash
   */
  private calculateHash(content: string): string {
    const normalized = content.replace(/\s+/g, '').toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }
}
