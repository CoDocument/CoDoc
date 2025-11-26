/**
 * FileSystemSyncService
 * 
 * Robust synchronization between CoDoc schema (single source of truth) and file system.
 * Handles complex operations: create, delete, rename, move, reorder with AST awareness.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SchemaNode, StructuralDiff, DependencyGraph } from '../types.js';
import {
  parseCode,
  generateCode,
  traverse,
  t,
  getDeclarationPatterns,
  elementExistsInCode,
  removeCodeElement,
  renameCodeElement,
  extractCodeElementContent,
  removeCodeElementByRegex
} from './BabelUtils.js';

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
          if (elementExistsInCode(content, node.name, node.type as 'function' | 'component')) {
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
   * Add placeholder code robustly (AST-based, prevents duplicates)
   */
  private async addPlaceholderCodeRobust(filePath: string, node: SchemaNode): Promise<void> {
    let content = await fs.readFile(filePath, 'utf-8');
    
    // Check if element already exists
    if (elementExistsInCode(content, node.name, node.type as 'function' | 'component')) {
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
    
    // Try AST-based removal for JS/TS files
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
      const result = removeCodeElement(content, name, type as 'function' | 'component');
      if (result !== null) {
        await fs.writeFile(filePath, result, 'utf-8');
        return;
      }
    }
    
    // Fallback: regex-based removal
    const updatedContent = removeCodeElementByRegex(content, name, type as 'function' | 'component');
    await fs.writeFile(filePath, updatedContent, 'utf-8');
  }

  /**
   * Rename code element robustly using AST
   */
  private async renameCodeElementRobust(filePath: string, oldName: string, newName: string, type: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath);
    
    // Try AST-based renaming for JS/TS files
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
      const result = renameCodeElement(content, oldName, newName);
      if (result !== null) {
        await fs.writeFile(filePath, result, 'utf-8');
        return;
      }
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
    const result = extractCodeElementContent(content, name, type as 'function' | 'component');
    
    if (result) {
      return result;
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
  return <div>${node.name}</div>;
}`;
    } else if (node.type === 'function') {
      return `export function ${node.name}() {
  throw new Error('Not implemented');
}`;
    }
    
    return `// ${node.name}\n`;
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
