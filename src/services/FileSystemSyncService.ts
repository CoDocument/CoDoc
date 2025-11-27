/**
 * FileSystemSyncService
 * 
 * Robust synchronization between CoDoc schema (single source of truth) and file system.
 * Handles complex operations: create, delete, rename, move, reorder with AST awareness.
 * 
 * Enhanced with:
 * - Batch operation support for multiple simultaneous changes
 * - Graceful error handling (tolerant mode)
 * - Freeform node support (unrecognized content preserved)
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
  type: 'create-file' | 'create-folder' | 'create-placeholder' | 'delete' | 'rename' | 'move' | 'skip';
  node: SchemaNode;
  oldPath?: string;
  newPath?: string;
  affectedNodes?: string[]; // Node IDs affected by this operation
  error?: string; // Error message if operation failed but was tolerated
}

export interface SyncResult {
  success: boolean;
  operations: SyncOperation[];
  errors: string[];
  warnings: string[]; // Non-fatal issues
  skippedNodes: SchemaNode[]; // Nodes that were skipped (freeform, etc.)
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
  
  // Pending operations queue for batch processing
  private pendingOperations: SyncOperation[] = [];
  private isBatchProcessing = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }
  
  /**
   * Build registry of existing code elements from current schema
   */
  private async buildCodeElementRegistry(schema: SchemaNode[]): Promise<void> {
    this.codeElementRegistry.clear();
    
    const processNode = async (node: SchemaNode) => {
      // Skip freeform/unrecognized nodes
      if (node.type === 'freeform' || node.isUnrecognized) {
        return;
      }
      
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
   * Enhanced with batch support and tolerance for failures
   */
  async syncChanges(
    diff: StructuralDiff,
    currentSchema: SchemaNode[],
    dependencyGraph: DependencyGraph
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      operations: [],
      errors: [],
      warnings: [],
      skippedNodes: []
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

      // Group operations by type for batch processing
      const addedFiles: SchemaNode[] = [];
      const addedFolders: SchemaNode[] = [];
      const addedElements: SchemaNode[] = [];
      const skipped: SchemaNode[] = [];
      
      // Categorize additions
      for (const node of diff.added) {
        if (node.type === 'freeform' || node.isUnrecognized || node.isComment) {
          skipped.push(node);
          continue;
        }
        
        if (node.type === 'directory') {
          addedFolders.push(node);
        } else if (node.type === 'file') {
          addedFiles.push(node);
        } else if (node.type === 'function' || node.type === 'component') {
          addedElements.push(node);
        } else {
          skipped.push(node); // Skip notes, references, etc. for now
        }
      }
      
      result.skippedNodes = skipped;
      if (skipped.length > 0) {
        result.warnings.push(`Skipped ${skipped.length} unrecognized or freeform nodes`);
      }

      // Process in correct order: renames first, then removals, then additions, then modifications
      
      // 1. Process renames (before removals to avoid conflicts)
      for (const { from, to } of diff.renamed) {
        // Skip freeform nodes and comments
        if (from.type === 'freeform' || from.isUnrecognized || from.isComment || 
            to.type === 'freeform' || to.isUnrecognized || to.isComment) {
          result.warnings.push(`Skipped rename for freeform/comment node: ${from.name} -> ${to.name}`);
          continue;
        }
        
        try {
          const op = await this.renameNodeTolerant(from, to);
          result.operations.push(op);
        } catch (error) {
          const errorMsg = `Failed to rename ${from.path} to ${to.path}: ${error}`;
          result.errors.push(errorMsg);
          result.operations.push({
            type: 'skip',
            node: to,
            oldPath: from.path,
            newPath: to.path,
            error: errorMsg
          });
        }
      }

      // 2. Process removals (with dependency awareness)
      for (const node of diff.removed) {
        // Skip freeform nodes and comments
        if (node.type === 'freeform' || node.isUnrecognized || node.isComment) {
          result.warnings.push(`Skipped removal of freeform/comment node: ${node.name}`);
          continue;
        }
        
        try {
          const affectedNodes = this.getAffectedNodes(node, dependencyGraph);
          const op = await this.deleteNodeTolerant(node, affectedNodes);
          result.operations.push(op);
        } catch (error) {
          const errorMsg = `Failed to delete ${node.path}: ${error}`;
          result.errors.push(errorMsg);
          result.operations.push({
            type: 'skip',
            node,
            error: errorMsg
          });
        }
      }

      // 3. Process additions in batch (folders first, then files, then elements)
      // Process folders
      for (const node of addedFolders) {
        try {
          const op = await this.createPlaceholderTolerant(node);
          result.operations.push(op);
        } catch (error) {
          const errorMsg = `Failed to create folder ${node.path}: ${error}`;
          result.warnings.push(errorMsg);
          result.operations.push({
            type: 'skip',
            node,
            error: errorMsg
          });
        }
      }
      
      // Process files
      for (const node of addedFiles) {
        try {
          const op = await this.createPlaceholderTolerant(node);
          result.operations.push(op);
        } catch (error) {
          const errorMsg = `Failed to create file ${node.path}: ${error}`;
          result.warnings.push(errorMsg);
          result.operations.push({
            type: 'skip',
            node,
            error: errorMsg
          });
        }
      }
      
      // Process code elements in batch (grouped by file)
      const elementsByFile = new Map<string, SchemaNode[]>();
      for (const node of addedElements) {
        const filePath = this.getFilePathForNode(node);
        if (filePath) {
          if (!elementsByFile.has(filePath)) {
            elementsByFile.set(filePath, []);
          }
          elementsByFile.get(filePath)!.push(node);
        } else {
          result.warnings.push(`Could not determine file for element: ${node.name}`);
          result.skippedNodes.push(node);
        }
      }
      
      // Batch add elements per file
      for (const [filePath, elements] of elementsByFile) {
        try {
          const ops = await this.batchAddElementsToFile(filePath, elements);
          result.operations.push(...ops);
        } catch (error) {
          const errorMsg = `Failed to add elements to ${filePath}: ${error}`;
          result.warnings.push(errorMsg);
          for (const element of elements) {
            result.operations.push({
              type: 'skip',
              node: element,
              error: errorMsg
            });
          }
        }
      }

      // 4. Process modifications (reorder, update)
      for (const node of diff.modified) {
        // Skip freeform nodes and comments
        if (node.type === 'freeform' || node.isUnrecognized || node.isComment) {
          continue;
        }
        
        try {
          const op = await this.updateNode(node);
          if (op) {
            result.operations.push(op);
          }
        } catch (error) {
          const errorMsg = `Failed to update ${node.path}: ${error}`;
          result.warnings.push(errorMsg);
        }
      }

      // Determine overall success (success even if some operations had warnings)
      result.success = result.errors.length === 0;

    } catch (error) {
      result.success = false;
      result.errors.push(`Sync failed: ${error}`);
    }

    return result;
  }

  /**
   * Batch add multiple code elements to a single file
   * More efficient than adding one at a time
   */
  private async batchAddElementsToFile(filePath: string, elements: SchemaNode[]): Promise<SyncOperation[]> {
    const operations: SyncOperation[] = [];
    const fullFilePath = path.join(this.workspaceRoot, filePath);
    
    // Ensure file exists
    try {
      await fs.access(fullFilePath);
    } catch {
      // File doesn't exist, create it
      await fs.mkdir(path.dirname(fullFilePath), { recursive: true });
      await fs.writeFile(fullFilePath, '', 'utf-8');
    }
    
    let content = await fs.readFile(fullFilePath, 'utf-8');
    let modified = false;
    
    for (const node of elements) {
      // Check if element already exists in registry
      const registry = this.codeElementRegistry.get(filePath);
      if (registry?.has(node.name)) {
        // Double-check in actual content
        if (elementExistsInCode(content, node.name, node.type as 'function' | 'component')) {
          operations.push({
            type: 'skip',
            node,
            error: 'Element already exists'
          });
          continue;
        }
      }
      
      // Generate placeholder and append
      const placeholder = this.generateCodePlaceholder(node);
      
      if (!content.endsWith('\n') && content.length > 0) {
        content += '\n';
      }
      content += `\n${placeholder}\n`;
      modified = true;
      
      // Update registry
      if (!this.codeElementRegistry.has(filePath)) {
        this.codeElementRegistry.set(filePath, new Set());
      }
      this.codeElementRegistry.get(filePath)!.add(node.name);
      
      operations.push({
        type: 'create-placeholder',
        node
      });
    }
    
    // Write once after all modifications
    if (modified) {
      await fs.writeFile(fullFilePath, content, 'utf-8');
    }
    
    return operations;
  }

  /**
   * Create placeholder for new node - tolerant version
   * Returns operation with error info instead of throwing
   */
  private async createPlaceholderTolerant(node: SchemaNode): Promise<SyncOperation> {
    // Skip freeform nodes and comments
    if (node.type === 'freeform' || node.isUnrecognized || node.isComment) {
      return {
        type: 'skip',
        node,
        error: 'Freeform/comment node - skipped'
      };
    }
    
    const fullPath = path.join(this.workspaceRoot, node.path);
    
    if (node.type === 'directory') {
      try {
        await fs.mkdir(fullPath, { recursive: true });
        return { type: 'create-folder', node };
      } catch (error) {
        return {
          type: 'skip',
          node,
          error: `Could not create directory: ${error}`
        };
      }
    } else if (node.type === 'file') {
      try {
        // Create parent directory if needed
        const dirPath = path.dirname(fullPath);
        await fs.mkdir(dirPath, { recursive: true });
        
        // Check if file already exists
        try {
          await fs.access(fullPath);
          return { type: 'create-file', node };
        } catch {
          // File doesn't exist, create it
          const content = this.generateFileTemplate(node);
          await fs.writeFile(fullPath, content, 'utf-8');
        }
        
        return { type: 'create-file', node };
      } catch (error) {
        return {
          type: 'skip',
          node,
          error: `Could not create file: ${error}`
        };
      }
    } else if (node.type === 'function' || node.type === 'component') {
      // Handle via batch processing
      const filePath = this.getFilePathForNode(node);
      if (!filePath) {
        return {
          type: 'skip',
          node,
          error: 'Cannot determine file path for element'
        };
      }
      
      try {
        const ops = await this.batchAddElementsToFile(filePath, [node]);
        return ops[0] || { type: 'create-placeholder', node };
      } catch (error) {
        return {
          type: 'skip',
          node,
          error: `Could not add element: ${error}`
        };
      }
    }

    return { type: 'skip', node, error: 'Unknown node type' };
  }

  /**
   * Delete node from file system - tolerant version
   */
  private async deleteNodeTolerant(node: SchemaNode, affectedNodes: string[]): Promise<SyncOperation> {
    // Skip freeform nodes and comments - they don't have filesystem representations
    if (node.type === 'freeform' || node.isUnrecognized || node.isComment) {
      return {
        type: 'skip',
        node,
        affectedNodes,
        error: 'Freeform/comment node - skipped'
      };
    }
    
    if (node.type === 'directory') {
      const fullPath = path.join(this.workspaceRoot, node.path);
      try {
        await fs.rm(fullPath, { recursive: true, force: true });
      } catch (error) {
        return {
          type: 'skip',
          node,
          affectedNodes,
          error: `Directory not found or could not be deleted: ${error}`
        };
      }
    } else if (node.type === 'file') {
      const fullPath = path.join(this.workspaceRoot, node.path);
      try {
        await fs.unlink(fullPath);
        this.codeElementRegistry.delete(node.path);
      } catch (error) {
        return {
          type: 'skip',
          node,
          affectedNodes,
          error: `File not found or could not be deleted: ${error}`
        };
      }
    } else if (node.type === 'function' || node.type === 'component') {
      const filePath = this.getFilePathForNode(node);
      if (!filePath) {
        return {
          type: 'skip',
          node,
          affectedNodes,
          error: 'Cannot determine file path for element'
        };
      }
      
      const fullFilePath = path.join(this.workspaceRoot, filePath);
      
      try {
        await this.removeCodeElementRobust(fullFilePath, node.name, node.type);
        
        const registry = this.codeElementRegistry.get(filePath);
        if (registry) {
          registry.delete(node.name);
        }
      } catch (error) {
        return {
          type: 'skip',
          node,
          affectedNodes,
          error: `Could not remove code element: ${error}`
        };
      }
    }

    return { type: 'delete', node, affectedNodes };
  }

  /**
   * Rename node in file system - tolerant version
   */
  private async renameNodeTolerant(from: SchemaNode, to: SchemaNode): Promise<SyncOperation> {
    if (from.type === 'directory') {
      const oldPath = path.join(this.workspaceRoot, from.path);
      const newPath = path.join(this.workspaceRoot, to.path);
      
      try {
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
      } catch (error) {
        return {
          type: 'skip',
          node: to,
          oldPath: from.path,
          newPath: to.path,
          error: `Could not rename directory: ${error}`
        };
      }
    } else if (from.type === 'file') {
      const oldPath = path.join(this.workspaceRoot, from.path);
      const newPath = path.join(this.workspaceRoot, to.path);
      
      try {
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
        
        const registry = this.codeElementRegistry.get(from.path);
        if (registry) {
          this.codeElementRegistry.delete(from.path);
          this.codeElementRegistry.set(to.path, registry);
        }
      } catch (error) {
        return {
          type: 'skip',
          node: to,
          oldPath: from.path,
          newPath: to.path,
          error: `Could not rename file: ${error}`
        };
      }
    } else if (from.type === 'function' || from.type === 'component') {
      const oldFilePath = this.getFilePathForNode(from);
      const newFilePath = this.getFilePathForNode(to);
      
      if (!oldFilePath || !newFilePath) {
        return {
          type: 'skip',
          node: to,
          oldPath: from.path,
          newPath: to.path,
          error: 'Cannot determine file paths for rename'
        };
      }
      
      // Case 1: Rename within same file
      if (oldFilePath === newFilePath) {
        const fullFilePath = path.join(this.workspaceRoot, oldFilePath);
        try {
          await this.renameCodeElementRobust(fullFilePath, from.name, to.name, from.type);
          
          const registry = this.codeElementRegistry.get(oldFilePath);
          if (registry) {
            registry.delete(from.name);
            registry.add(to.name);
          }
        } catch (error) {
          return {
            type: 'skip',
            node: to,
            oldPath: from.path,
            newPath: to.path,
            error: `Could not rename code element: ${error}`
          };
        }
      } 
      // Case 2: Move to different file
      else {
        try {
          const oldFullPath = path.join(this.workspaceRoot, oldFilePath);
          const elementCode = await this.extractCodeElement(oldFullPath, from.name, from.type);
          await this.removeCodeElementRobust(oldFullPath, from.name, from.type);
          
          const newFullPath = path.join(this.workspaceRoot, newFilePath);
          await this.insertCodeElement(newFullPath, elementCode, to.name);
          
          const oldRegistry = this.codeElementRegistry.get(oldFilePath);
          if (oldRegistry) {
            oldRegistry.delete(from.name);
          }
          if (!this.codeElementRegistry.has(newFilePath)) {
            this.codeElementRegistry.set(newFilePath, new Set());
          }
          this.codeElementRegistry.get(newFilePath)!.add(to.name);
        } catch (error) {
          return {
            type: 'skip',
            node: to,
            oldPath: from.path,
            newPath: to.path,
            error: `Could not move code element: ${error}`
          };
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
    // Skip freeform nodes
    if (node.type === 'freeform' || node.isUnrecognized) {
      return null;
    }
    
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
