/**
 * CodeChangeAnalyzer - Analyzes code changes and classifies them for feedback
 */

import { SchemaNode } from '../types';
import { AnalysisEngine } from './AnalysisEngine';
import { structuralDiffEngine } from './StructuralDiffEngine';

export interface CodeChange {
  type: 'add' | 'remove' | 'modify';
  element: SchemaNode;
  content?: string;
  lineNumber: number;
  indentLevel: number;
  id: string;
}

export class CodeChangeAnalyzer {
  /**
   * Analyze changes between old and new CoDoc schemas
   */
  async analyzeChanges(
    oldContent: string,
    newContent: string,
    workspaceRoot: string
  ): Promise<CodeChange[]> {
    const changes: CodeChange[] = [];

    try {
      // Parse old and new content into schema nodes
      const oldLines = oldContent.split('\n');
      const newLines = newContent.split('\n');

      // Create analysis engine
      const analysisEngine = new AnalysisEngine(workspaceRoot);
      
      // Scan current codebase
      const snapshot = await analysisEngine.scanCodebase();
      const currentSchema = analysisEngine.constructCodoc(snapshot);

      // Build old schema from old content
      const oldSchema = this.parseCoDocContent(oldContent);
      const newSchema = this.parseCoDocContent(newContent);

      // Use structural diff to find changes
      const diff = structuralDiffEngine.compare(oldSchema, newSchema);

      // Convert structural diff to code changes
      for (const added of diff.added) {
        changes.push({
          type: 'add',
          element: added,
          content: this.extractNodeContent(added, newLines),
          lineNumber: added.lineNumber,
          indentLevel: added.column / 2,
          id: added.id
        });
      }

      for (const removed of diff.removed) {
        changes.push({
          type: 'remove',
          element: removed,
          content: this.extractNodeContent(removed, oldLines),
          lineNumber: removed.lineNumber,
          indentLevel: removed.column / 2,
          id: removed.id
        });
      }

      for (const modified of diff.modified) {
        changes.push({
          type: 'modify',
          element: modified,
          content: this.extractNodeContent(modified, newLines),
          lineNumber: modified.lineNumber,
          indentLevel: modified.column / 2,
          id: modified.id
        });
      }

      return changes;
    } catch (error) {
      console.error('Failed to analyze changes:', error);
      return [];
    }
  }

  /**
   * Parse CoDoc content into schema nodes
   */
  private parseCoDocContent(content: string): SchemaNode[] {
    const lines = content.split('\n');
    const root: SchemaNode[] = [];
    const stack: { node: SchemaNode; indentLevel: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indentLevel = Math.floor((line.length - line.trimStart().length) / 2);
      const node = this.parseLineToNode(trimmed, i + 1, indentLevel * 2);

      if (!node) continue;

      // Pop stack until we find the parent
      while (stack.length > 0 && stack[stack.length - 1].indentLevel >= indentLevel) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      }

      stack.push({ node, indentLevel });
    }

    return root;
  }

  /**
   * Parse a single line to a schema node
   */
  private parseLineToNode(line: string, lineNumber: number, column: number): SchemaNode | null {
    let type: SchemaNode['type'];
    let name: string;

    if (line.startsWith('/')) {
      type = 'directory';
      name = line.substring(1);
    } else if (line.match(/\.(tsx?|jsx?|ts|js|json|css|scss|html|md)$/)) {
      type = 'file';
      name = line;
    } else if (line.match(/^\$[a-zA-Z][a-zA-Z0-9_]*\(\)$/)) {
      type = 'function';
      name = line.substring(1, line.length - 2);
    } else if (line.match(/^%[a-zA-Z][a-zA-Z0-9_]*$/)) {
      type = 'component';
      name = line.substring(1);
    } else if (line.match(/^@[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/)) {
      type = 'reference';
      name = line.substring(1);
    } else {
      return null;
    }

    return {
      id: `${type}_${lineNumber}_${name}`,
      type,
      name,
      path: name,
      lineNumber,
      column,
      dependencies: [],
      dependents: [],
      contentHash: '',
      children: []
    };
  }

  /**
   * Extract content for a node from lines
   */
  private extractNodeContent(node: SchemaNode, lines: string[]): string {
    if (node.lineNumber <= 0 || node.lineNumber > lines.length) {
      return '';
    }

    const lineIndex = node.lineNumber - 1;
    let content = lines[lineIndex];

    // If node has children, include them
    if (node.children && node.children.length > 0) {
      const startIndent = node.column;
      let endLine = lineIndex;

      for (let i = lineIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const indent = line.length - line.trimStart().length;
        if (indent <= startIndent) break;

        endLine = i;
      }

      content = lines.slice(lineIndex, endLine + 1).join('\n');
    }

    return content;
  }
}

export const codeChangeAnalyzer = new CodeChangeAnalyzer();
