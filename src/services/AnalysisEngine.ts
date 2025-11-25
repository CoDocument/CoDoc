/**
 * Unified AnalysisEngine for codebase scanning and CODOC construction
 * Extracts code structure with dependency tracking
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import {
  CodebaseSnapshot,
  FileStructure,
  CodeElement,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  SchemaNode
} from '../types';
import * as crypto from 'crypto';

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
        size: stats.size
      };

      // Extract code elements with dependencies
      if (this.isCodeFile(relativePath)) {
        fileStructure.elements = await this.extractCodeElements(code, relativePath);
      }

      return fileStructure;
    } catch (error) {
      console.warn(`Error analyzing file ${fileUri.fsPath}:`, error);
      return null;
    }
  }

  /**
   * Extract code elements with dependency tracking using Babel
   */
  private async extractCodeElements(
    code: string,
    filePath: string
  ): Promise<CodeElement[]> {
    const elements: CodeElement[] = [];

    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
        errorRecovery: true
      });

      // Track imports at file level
      const fileImports: string[] = [];

      traverse(ast, {
        // Track imports
        ImportDeclaration: (path) => {
          const source = path.node.source.value;
          fileImports.push(source);
        },

        // Function declarations
        FunctionDeclaration: (path) => {
          const name = path.node.id?.name;
          if (!name) return;

          const isComponent = /^[A-Z]/.test(name);
          const isExported = this.isExported(path);

          const element: CodeElement = {
            name,
            type: isComponent ? 'component' : 'function',
            filePath,
            line: path.node.loc?.start.line ?? 1,
            column: path.node.loc?.start.column ?? 0,
            isExported,
            content: this.extractNodeContent(code, path.node),
            imports: [...fileImports],
            exports: isExported ? [name] : [],
            calls: this.extractFunctionCalls(path),
            references: this.extractReferences(path)
          };

          elements.push(element);
        },

        // Arrow functions and components
        VariableDeclarator: (path) => {
          const id = path.node.id;
          const init = path.node.init;
          const name = (id as any)?.name;

          if (!name || !init) return;

          if (
            init.type === 'ArrowFunctionExpression' ||
            init.type === 'FunctionExpression'
          ) {
            const isComponent = /^[A-Z]/.test(name);
            const isExported = this.isExported(path);

            const element: CodeElement = {
              name,
              type: isComponent ? 'component' : 'function',
              filePath,
              line: path.node.loc?.start.line ?? 1,
              column: path.node.loc?.start.column ?? 0,
              isExported,
              content: this.extractNodeContent(code, path.node),
              imports: [...fileImports],
              exports: isExported ? [name] : [],
              calls: this.extractFunctionCalls(path),
              references: this.extractReferences(path)
            };

            elements.push(element);
          }
          // Skip non-function variables - we don't track them in CoDoc
        },

        // Classes
        ClassDeclaration: (path) => {
          const name = path.node.id?.name;
          if (!name) return;

          const isExported = this.isExported(path);

          const element: CodeElement = {
            name,
            type: 'class',
            filePath,
            line: path.node.loc?.start.line ?? 1,
            column: path.node.loc?.start.column ?? 0,
            isExported,
            content: this.extractNodeContent(code, path.node),
            imports: [...fileImports],
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

    return elements;
  }

  /**
   * Extract function calls from AST path
   */
  private extractFunctionCalls(path: any): string[] {
    const calls: string[] = [];
    path.traverse({
      CallExpression: (callPath: any) => {
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
   * Extract variable/type references from AST path
   */
  private extractReferences(path: any): string[] {
    const refs: string[] = [];
    path.traverse({
      Identifier: (idPath: any) => {
        // Skip function parameters and declarations
        if (idPath.parent.type !== 'FunctionDeclaration' && idPath.parent.type !== 'VariableDeclarator') {
          refs.push(idPath.node.name);
        }
      }
    });
    return [...new Set(refs)];
  }

  /**
   * Check if node is exported
   */
  private isExported(path: any): boolean {
    let currentPath = path;
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
   * Extract node content from source
   */
  private extractNodeContent(code: string, node: any): string {
    if (node.loc) {
      const lines = code.split('\n');
      const startLine = node.loc.start.line - 1;
      const endLine = node.loc.end.line - 1;
      return lines.slice(startLine, endLine + 1).join('\n');
    }
    return '';
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

    // Step 5: Build edges based on imports and calls
    for (const file of files) {
      for (const element of file.elements) {
        const fromId = `${file.path}:${element.name}`;
        const fromNode = nodes.get(fromId);
        if (!fromNode) continue;

        // Process function calls
        for (const call of element.calls) {
          // Find target in same file or imported files
          const targetId = this.resolveReference(call, file.path, element.imports, files);
          if (targetId && nodes.has(targetId)) {
            edges.push({
              from: fromId,
              to: targetId,
              type: 'call',
              location: { file: file.path, line: element.line }
            });
            fromNode.upstream.push(targetId);
            nodes.get(targetId)!.downstream.push(fromId);
          }
        }

        // Process imports
        for (const imp of element.imports) {
          // Create import edge
          const targetFile = this.resolveImportPath(imp, file.path, files);
          if (targetFile) {
            // Link to file's exports
            const targetFileStructure = files.find(f => f.path === targetFile);
            if (targetFileStructure) {
              for (const targetElement of targetFileStructure.elements) {
                if (targetElement.isExported) {
                  const targetId = `${targetFile}:${targetElement.name}`;
                  if (nodes.has(targetId)) {
                    edges.push({
                      from: fromId,
                      to: targetId,
                      type: 'import',
                      location: { file: file.path, line: element.line }
                    });
                    fromNode.upstream.push(targetId);
                    nodes.get(targetId)!.downstream.push(fromId);
                  }
                }
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
    
    return Array.from(dirs).sort();
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
  constructCodoc(snapshot: CodebaseSnapshot): SchemaNode[] {
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
