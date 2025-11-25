/**
 * StructuralDiffEngine with content-hash-based rename detection
 * Detects add/remove/modify/rename/move/refactor changes in CODOC structure
 * 
 * This engine is used ONLY for comparing AI-generated changes:
 * - Before generation: Store CoDoc snapshot
 * - After generation: Rescan codebase and build new CoDoc
 * - Compare: Identify all structural changes made by AI
 */

import { SchemaNode, StructuralDiff, RenamedNode, AIChange } from '../types';
import * as crypto from 'crypto';

export class StructuralDiffEngine {
  /**
   * Compare two CODOC structures and detect changes
   */
  compare(oldNodes: SchemaNode[], newNodes: SchemaNode[]): StructuralDiff {
    const diff: StructuralDiff = {
      added: [],
      removed: [],
      modified: [],
      renamed: []
    };

    const oldFlat = this.flattenNodes(oldNodes);
    const newFlat = this.flattenNodes(newNodes);
    const oldByPath = this.buildPathMap(oldNodes);
    const newByPath = this.buildPathMap(newNodes);

    const matchedOldPaths = new Set<string>();
    const matchedNewPaths = new Set<string>();

    // Step 1: detect modifications at identical paths
    for (const [path, newNode] of newByPath) {
      const oldNode = oldByPath.get(path);
      if (!oldNode) {
        continue;
      }

      matchedOldPaths.add(path);
      matchedNewPaths.add(path);

      const oldHash = this.getComparableHash(oldNode);
      const newHash = this.getComparableHash(newNode);

      if (oldHash !== newHash) {
        diff.modified.push(newNode);
      }
    }

    // Step 2: prepare unmatched old nodes grouped by hash for rename detection
    const unmatchedOldNodes = oldFlat.filter(node => !matchedOldPaths.has(node.path));
    const oldHashBuckets = this.groupByContentHash(unmatchedOldNodes);

    // Step 3: detect additions and renames/moves
    for (const newNode of newFlat) {
      if (matchedNewPaths.has(newNode.path)) {
        continue;
      }

      const hashKey = this.getComparableHash(newNode);
      let renamedFrom: SchemaNode | undefined;

      if (hashKey && oldHashBuckets.has(hashKey)) {
        const bucket = oldHashBuckets.get(hashKey)!;
        renamedFrom = bucket.shift();
        if (bucket.length === 0) {
          oldHashBuckets.delete(hashKey);
        }
      }

      if (renamedFrom) {
        matchedOldPaths.add(renamedFrom.path);
        diff.renamed.push({
          from: renamedFrom,
          to: newNode,
          confidence: 1.0
        });
      } else if (!oldByPath.has(newNode.path)) {
        diff.added.push(newNode);
      }

      matchedNewPaths.add(newNode.path);
    }

    // Step 4: any remaining unmatched old nodes are removals
    for (const oldNode of oldFlat) {
      if (matchedOldPaths.has(oldNode.path)) {
        continue;
      }

      if (diff.renamed.some(r => r.from.path === oldNode.path)) {
        continue;
      }

      diff.removed.push(oldNode);
    }

    // Filter out relocated nodes from additions (they're already in renamed)
    diff.added = diff.added.filter(
      node => !diff.renamed.some(r => r.to.path === node.path)
    );

    return diff;
  }

  /**
   * Build path map for quick lookup
   */
  private buildPathMap(nodes: SchemaNode[]): Map<string, SchemaNode> {
    const map = new Map<string, SchemaNode>();
    
    const process = (nodes: SchemaNode[]) => {
      for (const node of nodes) {
        map.set(node.path, node);
        if (node.children) {
          process(node.children);
        }
      }
    };

    process(nodes);
    return map;
  }

  /**
   * Flatten schema nodes for easier processing
   */
  private flattenNodes(nodes: SchemaNode[]): SchemaNode[] {
    const flat: SchemaNode[] = [];

    const traverse = (items: SchemaNode[]) => {
      for (const node of items) {
        flat.push(node);
        if (node.children && node.children.length > 0) {
          traverse(node.children);
        }
      }
    };

    traverse(nodes);
    return flat;
  }

  private groupByContentHash(nodes: SchemaNode[]): Map<string, SchemaNode[]> {
    const map = new Map<string, SchemaNode[]>();

    for (const node of nodes) {
      const hashKey = this.getComparableHash(node);
      if (!hashKey) {
        continue;
      }

      if (!map.has(hashKey)) {
        map.set(hashKey, []);
      }

      map.get(hashKey)!.push(node);
    }

    return map;
  }

  private getComparableHash(node: SchemaNode): string | null {
    if (node.contentHash && node.contentHash.trim().length > 0) {
      return node.contentHash;
    }

    if (!node.children || node.children.length === 0) {
      return null;
    }

    const childSignature = node.children
      .map(child => `${child.type}:${child.name}`)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .join('|');

    if (!childSignature) {
      return null;
    }

    return crypto.createHash('sha256').update(childSignature).digest('hex').substring(0, 16);
  }

  /**
   * Format diff for display
   * Handles special case: relocations show parent directory added, not file duplicated
   */
  formatDiff(diff: StructuralDiff): string[] {
    const lines: string[] = [];

    // Group renamed nodes by parent directory changes
    const relocations = this.groupRelocations(diff.renamed);

    // Show directory additions from relocations
    for (const [newDir, files] of relocations) {
      lines.push(`+ /${newDir} (relocated ${files.length} items)`);
    }

    // Show true additions (not relocations)
    const trueAdditions = diff.added.filter(
      node => !this.isPartOfRelocation(node, relocations)
    );
    for (const node of trueAdditions) {
      lines.push(`+ ${this.formatNode(node)}`);
    }

    // Show removals (excluding relocated items)
    const trueRemovals = diff.removed.filter(
      node => !diff.renamed.some(r => r.from.path === node.path)
    );
    for (const node of trueRemovals) {
      lines.push(`- ${this.formatNode(node)}`);
    }

    // Show modifications
    for (const node of diff.modified) {
      lines.push(`~ ${this.formatNode(node)}`);
    }

    // Show explicit renames (name changed, not just moved)
    for (const rename of diff.renamed) {
      if (rename.from.name !== rename.to.name) {
        lines.push(`→ ${rename.from.name} → ${rename.to.name}`);
      }
    }

    return lines;
  }

  /**
   * Group relocations by target directory
   */
  private groupRelocations(renamed: RenamedNode[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const item of renamed) {
      const oldDir = item.from.path.split('/').slice(0, -1).join('/');
      const newDir = item.to.path.split('/').slice(0, -1).join('/');

      if (oldDir !== newDir) {
        if (!groups.has(newDir)) {
          groups.set(newDir, []);
        }
        groups.get(newDir)!.push(item.to.name);
      }
    }

    return groups;
  }

  /**
   * Check if node is part of a relocation
   */
  private isPartOfRelocation(
    node: SchemaNode,
    relocations: Map<string, string[]>
  ): boolean {
    for (const [dir, files] of relocations) {
      if (node.path.startsWith(dir) && files.includes(node.name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Format node for display
   */
  private formatNode(node: SchemaNode): string {
    const indent = '  '.repeat(Math.floor(node.column / 2));
    let prefix = '';

    switch (node.type) {
      case 'directory':
        prefix = '/';
        break;
      case 'component':
        prefix = '%';
        break;
      case 'function':
        prefix = '$';
        return `${indent}${prefix}${node.name}()`;
      case 'reference':
        prefix = '@';
        break;
      case 'note':
        prefix = '# ';
        break;
    }

    return `${indent}${prefix}${node.name}`;
  }

  /**
   * Convert StructuralDiff to AIChange[] for feedback decorations
   * Classifies changes comprehensively: add/remove/modify/rename/move/refactor
   */
  convertToAIChanges(diff: StructuralDiff): AIChange[] {
    const changes: AIChange[] = [];
    const timestamp = Date.now();

    // Process additions
    for (const node of diff.added) {
      changes.push({
        id: `add_${node.id}_${timestamp}`,
        type: 'add',
        element: {
          type: this.mapNodeTypeToElementType(node.type),
          name: node.name,
          path: node.path
        },
        lineNumber: node.lineNumber,
        indentLevel: Math.floor(node.column / 2),
        content: this.formatNodeAsCoDoc(node),
        confidence: 1.0,
        timestamp
      });
    }

    // Process removals
    for (const node of diff.removed) {
      changes.push({
        id: `remove_${node.id}_${timestamp}`,
        type: 'remove',
        element: {
          type: this.mapNodeTypeToElementType(node.type),
          name: node.name,
          path: node.path
        },
        lineNumber: node.lineNumber,
        indentLevel: Math.floor(node.column / 2),
        content: this.formatNodeAsCoDoc(node),
        originalContent: this.formatNodeAsCoDoc(node),
        confidence: 1.0,
        timestamp
      });
    }

    // Process modifications
    for (const node of diff.modified) {
      changes.push({
        id: `modify_${node.id}_${timestamp}`,
        type: 'modify',
        element: {
          type: this.mapNodeTypeToElementType(node.type),
          name: node.name,
          path: node.path
        },
        lineNumber: node.lineNumber,
        indentLevel: Math.floor(node.column / 2),
        content: this.formatNodeAsCoDoc(node),
        confidence: 1.0,
        timestamp
      });
    }

    // Process renames - distinguish between rename and move
    for (const rename of diff.renamed) {
      const fromDir = rename.from.path.split('/').slice(0, -1).join('/');
      const toDir = rename.to.path.split('/').slice(0, -1).join('/');
      
      if (fromDir !== toDir) {
        // This is a move (path changed)
        changes.push({
          id: `move_${rename.to.id}_${timestamp}`,
          type: 'move',
          element: {
            type: this.mapNodeTypeToElementType(rename.to.type),
            name: rename.to.name,
            path: rename.to.path
          },
          lineNumber: rename.to.lineNumber,
          indentLevel: Math.floor(rename.to.column / 2),
          content: this.formatNodeAsCoDoc(rename.to),
          fromPath: rename.from.path,
          toPath: rename.to.path,
          confidence: rename.confidence,
          timestamp
        });
      } else if (rename.from.name !== rename.to.name) {
        // This is a pure rename (name changed, same location)
        changes.push({
          id: `rename_${rename.to.id}_${timestamp}`,
          type: 'rename',
          element: {
            type: this.mapNodeTypeToElementType(rename.to.type),
            name: rename.to.name,
            path: rename.to.path
          },
          lineNumber: rename.to.lineNumber,
          indentLevel: Math.floor(rename.to.column / 2),
          content: this.formatNodeAsCoDoc(rename.to),
          fromName: rename.from.name,
          toName: rename.to.name,
          confidence: rename.confidence,
          timestamp
        });
      }
    }

    // Detect refactorings (heuristic-based)
    const refactorChanges = this.detectRefactorings(diff);
    changes.push(...refactorChanges);

    return changes;
  }

  /**
   * Detect refactoring patterns in structural changes
   */
  private detectRefactorings(diff: StructuralDiff): AIChange[] {
    const refactorings: AIChange[] = [];
    const timestamp = Date.now();

    // Pattern 1: Function extracted (new function + modified calling function)
    const potentialExtracts = this.findExtractedFunctions(diff);
    for (const extract of potentialExtracts) {
      refactorings.push({
        id: `refactor_extract_${extract.id}_${timestamp}`,
        type: 'refactor',
        refactorType: 'extract',
        element: {
          type: 'function',
          name: extract.name,
          path: extract.path
        },
        lineNumber: extract.lineNumber,
        indentLevel: Math.floor(extract.column / 2),
        content: this.formatNodeAsCoDoc(extract),
        confidence: 0.8,
        timestamp
      });
    }

    // Pattern 2: Function inlined (removed function + modified calling function)
    const potentialInlines = this.findInlinedFunctions(diff);
    for (const inline of potentialInlines) {
      refactorings.push({
        id: `refactor_inline_${inline.id}_${timestamp}`,
        type: 'refactor',
        refactorType: 'inline',
        element: {
          type: 'function',
          name: inline.name,
          path: inline.path
        },
        lineNumber: inline.lineNumber,
        indentLevel: Math.floor(inline.column / 2),
        content: this.formatNodeAsCoDoc(inline),
        confidence: 0.7,
        timestamp
      });
    }

    // Pattern 3: Function split (1 removed, N>1 added with similar names/paths)
    const potentialSplits = this.findSplitFunctions(diff);
    for (const split of potentialSplits) {
      refactorings.push({
        id: `refactor_split_${split.id}_${timestamp}`,
        type: 'refactor',
        refactorType: 'split',
        element: {
          type: 'function',
          name: split.name,
          path: split.path
        },
        lineNumber: split.lineNumber,
        indentLevel: Math.floor(split.column / 2),
        content: this.formatNodeAsCoDoc(split),
        confidence: 0.75,
        timestamp
      });
    }

    return refactorings;
  }

  /**
   * Find extracted functions (new small functions + modified larger function)
   */
  private findExtractedFunctions(diff: StructuralDiff): SchemaNode[] {
    const extracted: SchemaNode[] = [];
    
    // Look for added functions that are small and simple
    for (const added of diff.added) {
      if (added.type === 'function') {
        // Check if there's a modified function in same file
        const sameFileModified = diff.modified.filter(m => 
          m.type === 'function' && 
          this.getFilePath(m.path) === this.getFilePath(added.path)
        );
        
        if (sameFileModified.length > 0) {
          extracted.push(added);
        }
      }
    }
    
    return extracted;
  }

  /**
   * Find inlined functions (removed functions + modified caller)
   */
  private findInlinedFunctions(diff: StructuralDiff): SchemaNode[] {
    const inlined: SchemaNode[] = [];
    
    for (const removed of diff.removed) {
      if (removed.type === 'function') {
        // Check if there's a modified function that might have inlined this
        const potentialInliners = diff.modified.filter(m =>
          m.type === 'function' &&
          this.getFilePath(m.path) === this.getFilePath(removed.path)
        );
        
        if (potentialInliners.length > 0) {
          inlined.push(removed);
        }
      }
    }
    
    return inlined;
  }

  /**
   * Find split functions (1 removed, multiple added with related names)
   */
  private findSplitFunctions(diff: StructuralDiff): SchemaNode[] {
    const splits: SchemaNode[] = [];
    
    for (const removed of diff.removed) {
      if (removed.type === 'function') {
        // Look for multiple added functions with similar name patterns
        const similarAdded = diff.added.filter(a =>
          a.type === 'function' &&
          this.getFilePath(a.path) === this.getFilePath(removed.path) &&
          this.hasSimilarName(a.name, removed.name)
        );
        
        if (similarAdded.length >= 2) {
          splits.push(...similarAdded);
        }
      }
    }
    
    return splits;
  }

  /**
   * Check if two names are similar (for split detection)
   */
  private hasSimilarName(name1: string, name2: string): boolean {
    const lower1 = name1.toLowerCase();
    const lower2 = name2.toLowerCase();
    
    // Check if one contains the other
    if (lower1.includes(lower2) || lower2.includes(lower1)) {
      return true;
    }
    
    // Check if they share significant prefix/suffix
    const words1 = lower1.split(/(?=[A-Z])|_/);
    const words2 = lower2.split(/(?=[A-Z])|_/);
    
    const commonWords = words1.filter(w => words2.includes(w));
    return commonWords.length >= 2;
  }

  /**
   * Extract file path from full path
   */
  private getFilePath(path: string): string {
    // Remove element name after # if present
    const parts = path.split('#');
    return parts[0];
  }

  /**
   * Map SchemaNode type to element type
   */
  private mapNodeTypeToElementType(type: SchemaNode['type']): AIChange['element']['type'] {
    switch (type) {
      case 'component':
        return 'component';
      case 'function':
        return 'function';
      case 'file':
        return 'file';
      case 'directory':
        return 'directory';
      case 'reference':
        return 'reference';
      default:
        return 'variable';
    }
  }

  /**
   * Format a schema node back into CoDoc syntax
   */
  private formatNodeAsCoDoc(node: SchemaNode): string {
    let prefix = '';
    
    switch (node.type) {
      case 'directory':
        prefix = '/';
        break;
      case 'component':
        prefix = '%';
        break;
      case 'function':
        return `$${node.name}()`;
      case 'reference':
        prefix = '@';
        break;
      case 'file':
        return node.name;
      case 'note':
        return `# ${node.content || node.name}`;
    }
    
    return `${prefix}${node.name}`;
  }
}

export const structuralDiffEngine = new StructuralDiffEngine();
