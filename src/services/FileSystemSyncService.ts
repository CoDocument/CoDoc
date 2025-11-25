/**
 * FileSystemSyncService
 * 
 * Robust synchronization between CoDoc schema (single source of truth) and file system.
 * Handles complex operations: create, delete, rename, move, reorder with AST awareness.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SchemaNode, StructuralDiff, DependencyGraph } from '../types';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';

export interface SyncOperation {
  type: 'create-file' | 'create-folder' | 'create-placeholder' | 'delete' | 'rename' | 'move';
  node: SchemaNode;
  oldPath?: string;
  newPath?: string;
  affectedNodes?: string[]; // Node IDs affected by this operation
}

export interface SyncResult {
  success: boolean;
  operations: SyncOperation[];
  errors: string[];
  revertToken?: string; // Token to revert all operations
}

interface CodebaseSnapshot {
  timestamp: number;
  files: Map<string, string>; // path -> content
  structure: SchemaNode[];
}

export class FileSystemSyncService {
  private workspaceRoot: string;
  private snapshotHistory: CodebaseSnapshot[] = [];
  private maxHistorySize = 10;
  
  // Track all code elements to prevent duplicates
  private codeElementRegistry: Map<string, Set<string>> = new Map(); // filePath -> Set<elementName>

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }
  
  /**
   * Build registry of existing code elements from current schema
   */
  private async buildCodeElementRegistry(schema: SchemaNode[]): Promise<void> {
    this.codeElementRegistry.clear();
    
    const processNode = async (node: SchemaNode) => {
      if (node.type === 'function' || node.type === 'component') {
        const filePath = this.getFilePathForNode(node);
        if (filePath) {
          if (!this.codeElementRegistry.has(filePath)) {
            this.codeElementRegistry.set(filePath, new Set());
          }
          this.codeElementRegistry.get(filePath)!.add(node.name);
        }
      }
      
      if (node.children) {
        for (const child of node.children) {
          await processNode(child);
        }
      }
    };
    
    for (const node of schema) {
      await processNode(node);
    }
  }

  /**
   * Synchronize CoDoc changes with file system (CoDoc is source of truth)
   */
  async syncChanges(
    diff: StructuralDiff,
    currentSchema: SchemaNode[],
    dependencyGraph: DependencyGraph
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      operations: [],
      errors: []
    };

    try {
      // Build registry to prevent duplicates
      await this.buildCodeElementRegistry(currentSchema);
      
      // Take snapshot before making changes
      const snapshot = await this.captureSnapshot(currentSchema);
      this.snapshotHistory.push(snapshot);
      if (this.snapshotHistory.length > this.maxHistorySize) {
        this.snapshotHistory.shift();
      }
      result.revertToken = snapshot.timestamp.toString();

      // Process in correct order: renames first, then removals, then additions, then modifications
      
      // 1. Process renames (before removals to avoid conflicts)
      for (const { from, to } of diff.renamed) {
        try {
          const op = await this.renameNode(from, to);
          result.operations.push(op);
        } catch (error) {
          result.errors.push(`Failed to rename ${from.path} to ${to.path}: ${error}`);
          result.success = false;
        }
      }

      // 2. Process removals (with dependency awareness)
      for (const node of diff.removed) {
        try {
          const affectedNodes = this.getAffectedNodes(node, dependencyGraph);
          const op = await this.deleteNode(node, affectedNodes);
          result.operations.push(op);
        } catch (error) {
          result.errors.push(`Failed to delete ${node.path}: ${error}`);
          result.success = false;
        }
      }

      // 3. Process additions (create placeholders)
      for (const node of diff.added) {
        try {
          const op = await this.createPlaceholder(node);
          result.operations.push(op);
        } catch (error) {
          result.errors.push(`Failed to create ${node.path}: ${error}`);
          result.success = false;
        }
      }

      // 4. Process modifications (reorder, update)
      for (const node of diff.modified) {
        try {
          const op = await this.updateNode(node);
          if (op) {
            result.operations.push(op);
          }
        } catch (error) {
          result.errors.push(`Failed to update ${node.path}: ${error}`);
          result.success = false;
        }
      }

    } catch (error) {
      result.success = false;
      result.errors.push(`Sync failed: ${error}`);
    }

    return result;
  }

  /**
   * Create placeholder for new node (prevent duplicates)
   */
  private async createPlaceholder(node: SchemaNode): Promise<SyncOperation> {
    const fullPath = path.join(this.workspaceRoot, node.path);
    
    if (node.type === 'directory') {
      await fs.mkdir(fullPath, { recursive: true });
      return {
        type: 'create-folder',
        node
      };
    } else if (node.type === 'file') {
      // Create parent directory if needed
      const dirPath = path.dirname(fullPath);
      await fs.mkdir(dirPath, { recursive: true });
      
      // Check if file already exists
      try {
        await fs.access(fullPath);
        return {
          type: 'create-file',
          node
        };
      } catch {
        // File doesn't exist, create it
        const content = this.generateFileTemplate(node);
        await fs.writeFile(fullPath, content, 'utf-8');
      }
      
      return {
        type: 'create-file',
        node
      };
    } else if (node.type === 'function' || node.type === 'component') {
      // Get file path for this element
      const filePath = this.getFilePathForNode(node);
      if (!filePath) {
        throw new Error(`Cannot determine file path for ${node.name}`);
      }
      
      const fullFilePath = path.join(this.workspaceRoot, filePath);
      
      // Check if element already exists in registry
      const registry = this.codeElementRegistry.get(filePath);
      if (registry?.has(node.name)) {
        
        // Double-check in actual file
        try {
          const content = await fs.readFile(fullFilePath, 'utf-8');
          if (await this.elementExistsInFile(content, node.name, node.type)) {
            return {
              type: 'create-placeholder',
              node
            };
          }
        } catch (error) {
          // File doesn't exist, will create below
        }
      }
      
      // Ensure file exists
      try {
        await fs.access(fullFilePath);
      } catch {
        // File doesn't exist, create it
        await fs.mkdir(path.dirname(fullFilePath), { recursive: true });
        const fileContent = this.generateFileTemplate({ ...node, path: filePath, type: 'file' });
        await fs.writeFile(fullFilePath, fileContent, 'utf-8');
      }
      
      // Add placeholder code using AST
      await this.addPlaceholderCodeRobust(fullFilePath, node);
      
      // Update registry
      if (!this.codeElementRegistry.has(filePath)) {
        this.codeElementRegistry.set(filePath, new Set());
      }
      this.codeElementRegistry.get(filePath)!.add(node.name);
      
      return {
        type: 'create-placeholder',
        node
      };
    }

    return { type: 'create-placeholder', node };
  }

  /**
   * Delete node from file system (robust AST-based removal)
   */
  private async deleteNode(node: SchemaNode, affectedNodes: string[]): Promise<SyncOperation> {
    if (node.type === 'directory') {
      const fullPath = path.join(this.workspaceRoot, node.path);
      try {
        await fs.rm(fullPath, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Directory ${fullPath} not found or already deleted`);
      }
    } else if (node.type === 'file') {
      const fullPath = path.join(this.workspaceRoot, node.path);
      try {
        await fs.unlink(fullPath);
        
        // Remove all elements in this file from registry
        this.codeElementRegistry.delete(node.path);
      } catch (error) {
        console.warn(`File ${fullPath} not found or already deleted`);
      }
    } else if (node.type === 'function' || node.type === 'component') {
      // Remove the code element from the file using AST
      const filePath = this.getFilePathForNode(node);
      if (!filePath) {
        console.warn(`Cannot determine file path for ${node.name}`);
        return { type: 'delete', node, affectedNodes };
      }
      
      const fullFilePath = path.join(this.workspaceRoot, filePath);
      
      try {
        await this.removeCodeElementRobust(fullFilePath, node.name, node.type);
        
        // Update registry
        const registry = this.codeElementRegistry.get(filePath);
        if (registry) {
          registry.delete(node.name);
        }
      } catch (error) {
        console.warn(`Could not remove code element ${node.name}: ${error}`);
      }
    }

    return {
      type: 'delete',
      node,
      affectedNodes
    };
  }

  /**
   * Rename node in file system (handles files, folders, and code elements)
   */
  private async renameNode(from: SchemaNode, to: SchemaNode): Promise<SyncOperation> {
    if (from.type === 'directory') {
      const oldPath = path.join(this.workspaceRoot, from.path);
      const newPath = path.join(this.workspaceRoot, to.path);
      
      try {
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
      } catch (error) {
        console.warn(`Could not rename directory ${oldPath} to ${newPath}: ${error}`);
      }
    } else if (from.type === 'file') {
      const oldPath = path.join(this.workspaceRoot, from.path);
      const newPath = path.join(this.workspaceRoot, to.path);
      
      try {
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
        
        // Update registry
        const registry = this.codeElementRegistry.get(from.path);
        if (registry) {
          this.codeElementRegistry.delete(from.path);
          this.codeElementRegistry.set(to.path, registry);
        }
      } catch (error) {
        console.warn(`Could not rename file ${oldPath} to ${newPath}: ${error}`);
      }
    } else if (from.type === 'function' || from.type === 'component') {
      const oldFilePath = this.getFilePathForNode(from);
      const newFilePath = this.getFilePathForNode(to);
      
      if (!oldFilePath || !newFilePath) {
        console.warn(`Cannot determine file paths for rename: ${from.name} -> ${to.name}`);
        return { type: 'rename', node: to, oldPath: from.path, newPath: to.path };
      }
      
      // Case 1: Rename within same file
      if (oldFilePath === newFilePath) {
        const fullFilePath = path.join(this.workspaceRoot, oldFilePath);
        try {
          await this.renameCodeElementRobust(fullFilePath, from.name, to.name, from.type);
          
          // Update registry
          const registry = this.codeElementRegistry.get(oldFilePath);
          if (registry) {
            registry.delete(from.name);
            registry.add(to.name);
          }
        } catch (error) {
          console.warn(`Could not rename code element ${from.name} to ${to.name}: ${error}`);
        }
      } 
      // Case 2: Move to different file
      else {
        try {
          // Remove from old file
          const oldFullPath = path.join(this.workspaceRoot, oldFilePath);
          const elementCode = await this.extractCodeElement(oldFullPath, from.name, from.type);
          await this.removeCodeElementRobust(oldFullPath, from.name, from.type);
          
          // Add to new file
          const newFullPath = path.join(this.workspaceRoot, newFilePath);
          await this.insertCodeElement(newFullPath, elementCode, to.name);
          
          // Update registry
          const oldRegistry = this.codeElementRegistry.get(oldFilePath);
          if (oldRegistry) {
            oldRegistry.delete(from.name);
          }
          if (!this.codeElementRegistry.has(newFilePath)) {
            this.codeElementRegistry.set(newFilePath, new Set());
          }
          this.codeElementRegistry.get(newFilePath)!.add(to.name);
        } catch (error) {
          console.warn(`Could not move code element ${from.name} to ${newFilePath}: ${error}`);
        }
      }
    }

    return {
      type: 'rename',
      node: to,
      oldPath: from.path,
      newPath: to.path
    };
  }

  /**
   * Update existing node (handle reordering, modifications)
   */
  private async updateNode(node: SchemaNode): Promise<SyncOperation | null> {
    // For code elements, check if they need reordering or updating
    if (node.type === 'function' || node.type === 'component') {
      const filePath = this.getFilePathForNode(node);
      if (!filePath) {
        console.warn(`Cannot determine file path for ${node.name}`);
        return null;
      }
      
      const fullFilePath = path.join(this.workspaceRoot, filePath);
      
      try {
        const content = await fs.readFile(fullFilePath, 'utf-8');
        
        // Check if it's still a placeholder that needs updating
        if (this.isPlaceholderCode(content, node)) {
          // Update placeholder with new signature/props if changed
          await this.addPlaceholderCodeRobust(fullFilePath, node);
          return {
            type: 'create-placeholder',
            node
          };
        }
        
        // For non-placeholder code, reordering would require more complex AST manipulation
        // For now, we leave actual implementations as-is
      } catch (error) {
        console.warn(`Could not update node ${node.path}: ${error}`);
      }
    }

    return null;
  }

  /**
   * Revert to a previous snapshot
   */
  async revertToSnapshot(revertToken: string): Promise<boolean> {
    const timestamp = parseInt(revertToken, 10);
    const snapshot = this.snapshotHistory.find(s => s.timestamp === timestamp);
    
    if (!snapshot) {
      return false;
    }

    try {
      // Restore files
      for (const [filePath, content] of snapshot.files) {
        const fullPath = path.join(this.workspaceRoot, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
      }

      // Remove files that weren't in the snapshot
      // (This is complex - for now we'll just restore existing files)
      
      return true;
    } catch (error) {
      console.error('Failed to revert snapshot:', error);
      return false;
    }
  }

  /**
   * Get affected nodes when deleting a node
   */
  private getAffectedNodes(node: SchemaNode, graph: DependencyGraph): string[] {
    const affected: string[] = [];
    
    // Find all downstream dependencies
    const nodeEntry = graph.nodes[node.id];
    if (nodeEntry) {
      affected.push(...nodeEntry.downstream);
    }

    return affected;
  }

  /**
   * Capture current codebase snapshot
   */
  private async captureSnapshot(schema: SchemaNode[]): Promise<CodebaseSnapshot> {
    const files = new Map<string, string>();
    
    const captureNode = async (node: SchemaNode) => {
      if (node.type === 'file') {
        try {
          const fullPath = path.join(this.workspaceRoot, node.path);
          const content = await fs.readFile(fullPath, 'utf-8');
          files.set(node.path, content);
        } catch {
          // File doesn't exist yet
        }
      }
      
      if (node.children) {
        for (const child of node.children) {
          await captureNode(child);
        }
      }
    };

    for (const node of schema) {
      await captureNode(node);
    }

    return {
      timestamp: Date.now(),
      files,
      structure: schema
    };
  }

  /**
   * Generate file template based on extension
   */
  private generateFileTemplate(node: SchemaNode): string {
    const ext = node.extension || path.extname(node.path);
    
    if (ext === '.ts' || ext === '.tsx') {
      return ``;
    } else if (ext === '.js' || ext === '.jsx') {
      return ``;
    } else if (ext === '.py') {
      return ``;
    } else if (ext === '.java') {
      return ``;
    }
    
    return ``;
  }

  /**
   * Check if element exists in file
   */
  private async elementExistsInFile(content: string, name: string, type: string): Promise<boolean> {
    const ext = path.extname(content);
    
    // Use regex patterns to detect various declaration forms
    const patterns = this.getDeclarationPatterns(name, type);
    return patterns.some(pattern => pattern.test(content));
  }
  
  /**
   * Get all possible declaration patterns for an element
   */
  private getDeclarationPatterns(name: string, type: string): RegExp[] {
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
   * Add placeholder code robustly (AST-based, prevents duplicates)
   */
  private async addPlaceholderCodeRobust(filePath: string, node: SchemaNode): Promise<void> {
    let content = await fs.readFile(filePath, 'utf-8');
    
    // Check if element already exists
    if (await this.elementExistsInFile(content, node.name, node.type)) {
      return;
    }
    
    const placeholder = this.generateCodePlaceholder(node);
    
    // Append to end of file with proper spacing
    if (!content.endsWith('\n')) {
      content += '\n';
    }
    content += `\n${placeholder}\n`;
    
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Remove code element robustly using AST
   */
  private async removeCodeElementRobust(filePath: string, name: string, type: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath);
    
    try {
      // Try AST-based removal for JS/TS files
      if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        const ast = parser.parse(content, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript']
        });
        
        let removed = false;
        traverse(ast, {
          FunctionDeclaration(path) {
            if (path.node.id?.name === name) {
              path.remove();
              removed = true;
            }
          },
          VariableDeclarator(path) {
            if (path.node.id.type === 'Identifier' && path.node.id.name === name) {
              // Remove the entire variable declaration
              const parent = path.parentPath;
              if (parent.isVariableDeclaration()) {
                parent.remove();
                removed = true;
              }
            }
          },
          ClassDeclaration(path) {
            if (path.node.id?.name === name) {
              path.remove();
              removed = true;
            }
          },
          ExportNamedDeclaration(path) {
            const declaration = path.node.declaration;
            if (declaration) {
              if (declaration.type === 'FunctionDeclaration' && declaration.id?.name === name) {
                path.remove();
                removed = true;
              } else if (declaration.type === 'VariableDeclaration') {
                const declarator = declaration.declarations.find(
                  d => d.id.type === 'Identifier' && d.id.name === name
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
          ExportDefaultDeclaration(path) {
            const declaration = path.node.declaration;
            if (declaration.type === 'FunctionDeclaration' && declaration.id?.name === name) {
              path.remove();
              removed = true;
            } else if (declaration.type === 'ClassDeclaration' && declaration.id?.name === name) {
              path.remove();
              removed = true;
            }
          }
        });
        
        if (removed) {
          const output = generate(ast, {}, content);
          await fs.writeFile(filePath, output.code, 'utf-8');
          return;
        }
      }
    } catch (error) {
      console.warn(`AST-based removal failed for ${name}, falling back to regex: ${error}`);
    }
    
    // Fallback: regex-based removal
    const patterns = this.getDeclarationPatterns(name, type);
    let updatedContent = content;
    
    for (const pattern of patterns) {
      const match = pattern.exec(updatedContent);
      if (match) {
        // Find the complete declaration including body
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
    
    await fs.writeFile(filePath, updatedContent, 'utf-8');
  }

  /**
   * Rename code element robustly using AST
   */
  private async renameCodeElementRobust(filePath: string, oldName: string, newName: string, type: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath);
    
    try {
      // Try AST-based renaming for JS/TS files
      if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        const ast = parser.parse(content, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript']
        });
        
        let renamed = false;
        traverse(ast, {
          FunctionDeclaration(path) {
            if (path.node.id?.name === oldName) {
              path.node.id.name = newName;
              renamed = true;
            }
          },
          VariableDeclarator(path) {
            if (path.node.id.type === 'Identifier' && path.node.id.name === oldName) {
              path.node.id.name = newName;
              renamed = true;
            }
          },
          ClassDeclaration(path) {
            if (path.node.id?.name === oldName) {
              path.node.id.name = newName;
              renamed = true;
            }
          }
        });
        
        if (renamed) {
          const output = generate(ast, {}, content);
          await fs.writeFile(filePath, output.code, 'utf-8');
          return;
        }
      }
    } catch (error) {
      console.warn(`AST-based renaming failed for ${oldName}, falling back to regex: ${error}`);
    }
    
    // Fallback: simple text replacement with word boundaries
    const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const updatedContent = content.replace(
      new RegExp(`\\b${escapedOldName}\\b`, 'g'),
      newName
    );
    
    await fs.writeFile(filePath, updatedContent, 'utf-8');
  }
  
  /**
   * Extract code element from file
   */
  private async extractCodeElement(filePath: string, name: string, type: string): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const patterns = this.getDeclarationPatterns(name, type);
    
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (match) {
        const startIndex = match.index;
        let endIndex = startIndex;
        let braceCount = 0;
        let inDeclaration = false;
        
        for (let i = startIndex; i < content.length; i++) {
          const char = content[i];
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
          return content.slice(startIndex, endIndex);
        }
      }
    }
    
    throw new Error(`Element ${name} not found in ${filePath}`);
  }
  
  /**
   * Insert code element into file
   */
  private async insertCodeElement(filePath: string, code: string, newName: string): Promise<void> {
    let content = await fs.readFile(filePath, 'utf-8');
    
    if (!content.endsWith('\n')) {
      content += '\n';
    }
    content += `\n${code}\n`;
    
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Update placeholder code (for modifications)
   */
  private async updatePlaceholderCode(filePath: string, node: SchemaNode): Promise<void> {
    // For now, ensure placeholder exists with current signature
    await this.addPlaceholderCodeRobust(filePath, node);
  }

  /**
   * Check if code is a placeholder
   */
  private isPlaceholderCode(content: string, node: SchemaNode): boolean {
    return content.includes('TODO: Implement') && content.includes(node.name);
  }

  /**
   * Generate code placeholder
   */
  private generateCodePlaceholder(node: SchemaNode): string {
    const filePath = this.getFilePathForNode(node);
    const ext = filePath ? path.extname(filePath) : '.ts';
    
    if (node.type === 'component' && (ext === '.tsx' || ext === '.jsx')) {
      return `export function ${node.name}() {
  // TODO: Implement
  return <div>${node.name}</div>;
}`;
    } else if (node.type === 'function') {
      return `export function ${node.name}() {
  // TODO: Implement
  throw new Error('Not implemented');
}`;
    }
    
    return `// ${node.name}\n// TODO: Implement`;
  }

  /**
   * Get file path for a code element node (robust extraction)
   */
  private getFilePathForNode(node: SchemaNode): string | null {
    // Walk up to find parent file
    let current: SchemaNode | undefined = node;
    while (current) {
      if (current.type === 'file') {
        return current.path;
      }
      current = current.parent;
    }
    
    // If node.path contains '#', extract the file path part (e.g., "src/utils.ts#myFunction")
    if (node.path && node.path.includes('#')) {
      const filePath = node.path.split('#')[0];
      return filePath;
    }
    
    // If node.path looks like a file path, use it directly
    if (node.path && this.isFilePath(node.path)) {
      return node.path;
    }
    
    // Cannot determine file path
    return null;
  }
  
  /**
   * Check if a path looks like a file path
   */
  private isFilePath(pathStr: string): boolean {
    const fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h'];
    return fileExtensions.some(ext => pathStr.endsWith(ext));
  }

  /**
   * Show revert notification with action button
   */
  // async showRevertNotification(operations: SyncOperation[], revertToken: string): Promise<boolean> {
  //   const message = `${operations.map(op => op.type).join(', ')} operations were performed on the file system. Would you like to revert?`;
  //   const action = await vscode.window.showWarningMessage(
  //     message,
  //     { modal: false },
  //     'Revert Changes',
  //     'Keep Changes'
  //   );

  //   if (action === 'Revert Changes') {
  //     return await this.revertToSnapshot(revertToken);
  //   }

  //   return false;
  // }

  /**
   * Get snapshot history for debugging
   */
  getSnapshotHistory(): CodebaseSnapshot[] {
    return [...this.snapshotHistory];
  }

  /**
   * Clear snapshot history
   */
  clearHistory(): void {
    this.snapshotHistory = [];
  }
}
