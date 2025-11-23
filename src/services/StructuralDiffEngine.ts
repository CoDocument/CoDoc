/**
 * StructuralDiffEngine with content-hash-based rename detection
 * Detects add/remove/modify/rename changes in CODOC structure
 */

import { SchemaNode, StructuralDiff, RenamedNode } from '../types';

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

    // Build hash maps for fast lookup
    const oldByHash = this.buildHashMap(oldNodes);
    const newByHash = this.buildHashMap(newNodes);
    const oldByPath = this.buildPathMap(oldNodes);
    const newByPath = this.buildPathMap(newNodes);

    // Detect additions and renames
    for (const [hash, newNode] of newByHash) {
      if (oldByHash.has(hash)) {
        // Same content hash exists - check for rename/relocation
        const oldNode = oldByHash.get(hash)!;
        if (oldNode.path !== newNode.path || oldNode.name !== newNode.name) {
          diff.renamed.push({
            from: oldNode,
            to: newNode,
            confidence: 1.0 // Perfect hash match
          });
        } else if (oldNode.contentHash !== newNode.contentHash) {
          // Same path but content changed
          diff.modified.push(newNode);
        }
      } else {
        // New hash - check if path exists with different content
        if (oldByPath.has(newNode.path)) {
          diff.modified.push(newNode);
        } else {
          diff.added.push(newNode);
        }
      }
    }

    // Detect removals (nodes in old but not in new)
    for (const [hash, oldNode] of oldByHash) {
      if (!newByHash.has(hash) && !this.isRenamed(oldNode, diff.renamed)) {
        // Check if path still exists (would be modification, already handled)
        if (!newByPath.has(oldNode.path)) {
          diff.removed.push(oldNode);
        }
      }
    }

    // Filter out relocated nodes from additions (they're already in renamed)
    diff.added = diff.added.filter(
      node => !diff.renamed.some(r => r.to.path === node.path)
    );

    // Recursively process children
    this.processChildren(oldNodes, newNodes, diff);

    return diff;
  }

  /**
   * Build hash map for quick lookup
   */
  private buildHashMap(nodes: SchemaNode[]): Map<string, SchemaNode> {
    const map = new Map<string, SchemaNode>();
    
    const process = (nodes: SchemaNode[]) => {
      for (const node of nodes) {
        map.set(node.contentHash, node);
        if (node.children) {
          process(node.children);
        }
      }
    };

    process(nodes);
    return map;
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
   * Check if node is in renamed list
   */
  private isRenamed(node: SchemaNode, renamed: RenamedNode[]): boolean {
    return renamed.some(r => r.from.path === node.path);
  }

  /**
   * Process children recursively
   */
  private processChildren(
    oldNodes: SchemaNode[],
    newNodes: SchemaNode[],
    diff: StructuralDiff
  ): void {
    for (const oldNode of oldNodes) {
      if (oldNode.children) {
        const newNode = newNodes.find(n => n.path === oldNode.path);
        if (newNode && newNode.children) {
          const childDiff = this.compare(oldNode.children, newNode.children);
          diff.added.push(...childDiff.added);
          diff.removed.push(...childDiff.removed);
          diff.modified.push(...childDiff.modified);
          diff.renamed.push(...childDiff.renamed);
        }
      }
    }
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
}

export const structuralDiffEngine = new StructuralDiffEngine();
