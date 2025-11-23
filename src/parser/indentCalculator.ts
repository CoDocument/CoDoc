/**
 * Parser-driven indentation calculator
 * Single source of truth for CODOC indentation rules
 */

import { SchemaNode } from "../types";
import { codocParser } from "./codocParser";

const INDENT_UNIT = 2; // CODOC standard: 2 spaces per level

/**
 * Calculate expected indent for next line after current position
 */
export function calculateExpectedIndent(
  content: string,
  lineNumber: number
): number {
  // Handle empty document
  if (!content || content.trim() === '') {
    return 0;
  }

  const lines = content.split('\n');
  
  // Get current line
  let targetLine = lineNumber - 1; // Convert to 0-based
  
  // If current line is empty, find previous non-empty line
  let currentLineContent = lines[targetLine] || '';
  if (currentLineContent.trim() === '') {
    // Search backwards for non-empty line
    for (let i = targetLine - 1; i >= 0; i--) {
      if (lines[i].trim() !== '') {
        targetLine = i;
        currentLineContent = lines[i];
        break;
      }
    }
  }

  // Parse the document up to (and including) the target line
  const contentUpToLine = lines.slice(0, targetLine + 1).join('\n');
  const parseResult = codocParser.parse(contentUpToLine);

  if (parseResult.errors.length > 0 || parseResult.nodes.length === 0) {
    // Fallback: use simple detection
    return calculateFallbackIndent(currentLineContent);
  }

  // Find the node corresponding to the target line
  const targetNode = findNodeAtLine(parseResult.nodes, targetLine + 1);

  if (!targetNode) {
    // No node found - use fallback
    return calculateFallbackIndent(currentLineContent);
  }

  // Use parser's logic to calculate expected indent for children
  return calculateExpectedIndentForChildren(targetNode, currentLineContent);
}

/**
 * Find node at specific line number
 */
function findNodeAtLine(nodes: SchemaNode[], lineNumber: number): SchemaNode | null {
  for (const node of nodes) {
    if (node.lineNumber === lineNumber) {
      return node;
    }
    if (node.children) {
      const found = findNodeAtLine(node.children, lineNumber);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Calculate expected indent for children of a node
 */
function calculateExpectedIndentForChildren(
  node: SchemaNode,
  lineContent: string
): number {
  // Get node's current indent by counting leading spaces
  const currentIndent = lineContent.match(/^(\s*)/)?.[1].length || 0;
  const indentLevel = Math.floor(currentIndent / INDENT_UNIT);

  switch (node.type) {
    case 'directory':
    case 'file':
      // These can have children, indent +1
      return (indentLevel + 1) * INDENT_UNIT;

    case 'function':
    case 'component':
    case 'reference':
    case 'note':
      // These don't have children, stay at same level (siblings)
      return indentLevel * INDENT_UNIT;

    default:
      // Unknown type, safe default
      return (indentLevel + 1) * INDENT_UNIT;
  }
}

/**
 * Fallback indent calculation based on simple text detection
 */
function calculateFallbackIndent(lineContent: string): number {
  // Get current line's indent
  const currentIndent = lineContent.match(/^(\s*)/)?.[1].length || 0;
  const indentLevel = Math.floor(currentIndent / INDENT_UNIT);
  const trimmed = lineContent.trim();

  // Simple type detection
  if (trimmed.startsWith('/') || trimmed.match(/\.\w+$/)) {
    // Directory or file - expect children
    return (indentLevel + 1) * INDENT_UNIT;
  }

  // Default: same level
  return indentLevel * INDENT_UNIT;
}
