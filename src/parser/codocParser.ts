/**
 * Main CODOC parser with dependency tracking
 * Builds hierarchical SchemaNode tree with validation
 */

import { SchemaNode } from "../types";
import { CodocLexer } from "./lexer";
import { lineParser, CodocLineParser } from "./lineParser";
import * as crypto from "crypto";

interface ParsingContext {
  stack: Array<{ node: SchemaNode; indent: number }>;
  allNodes: SchemaNode[];
  nodeCounter: number;
  validationMessages: string[];
}

export class CodocParser {
  private indentUnit = 2; // 2 spaces per indent level

  /**
   * Parse CODOC content into SchemaNode tree with dependency tracking
   */
  parse(content: string): { nodes: SchemaNode[]; errors: string[] } {
    const lines = content.split('\n');
    const context: ParsingContext = {
      stack: [],
      allNodes: [],
      nodeCounter: 0,
      validationMessages: []
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length || 0;
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        continue;
      }

      // Validate indent consistency
      if (leadingSpaces % this.indentUnit !== 0) {
        context.validationMessages.push(
          `Line ${lineIndex + 1}: Inconsistent indentation (${leadingSpaces} spaces). Should be multiple of ${this.indentUnit}.`
        );
      }

      const indentLevel = Math.floor(leadingSpaces / this.indentUnit);

      try {
        // Tokenize
        const lexResult = CodocLexer.tokenize(trimmed);
        if (lexResult.errors.length > 0) {
          // Skip incomplete tokens
          if (this.isIncompleteToken(trimmed)) {
            continue;
          }
          context.validationMessages.push(
            `Line ${lineIndex + 1}: Lexing error - ${lexResult.errors[0].message}`
          );
          continue;
        }

        // Parse
        lineParser.input = lexResult.tokens;
        const cst = lineParser.line();

        if (lineParser.errors.length > 0) {
          if (this.isIncompleteToken(trimmed)) {
            continue;
          }
          context.validationMessages.push(
            `Line ${lineIndex + 1}: Parsing error - ${lineParser.errors[0].message}`
          );
          continue;
        }

        // Build node
        const node = this.buildNodeFromCST(cst, trimmed, lineIndex + 1, indentLevel, context);
        if (!node) {
          continue;
        }

        // Attach to tree
        this.attachNodeToTree(node, indentLevel, context);

      } catch (error) {
        context.validationMessages.push(
          `Line ${lineIndex + 1}: Unexpected error - ${error}`
        );
      }
    }

    return {
      nodes: context.allNodes.filter(n => !n.parent),
      errors: context.validationMessages
    };
  }

  /**
   * Build SchemaNode from CST
   */
  private buildNodeFromCST(
    cst: any,
    originalText: string,
    lineNumber: number,
    indentLevel: number,
    context: ParsingContext
  ): SchemaNode | null {
    const id = `node_${context.nodeCounter++}`;

    // Determine node type and extract information
    if (cst.children.directoryDecl) {
      const name = cst.children.directoryDecl[0].children.Identifier[0].image;
      return {
        id,
        type: 'directory',
        name,
        path: `/${name}`,
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [],
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    if (cst.children.fileDecl) {
      const name = cst.children.fileDecl[0].children.Identifier[0].image;
      const ext = cst.children.fileDecl[0].children.FileExtension[0].image;
      return {
        id,
        type: 'file',
        name: name + ext,
        path: name + ext,
        extension: ext,
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [],
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    if (cst.children.componentDecl) {
      const fullToken = cst.children.componentDecl[0].children.Component[0].image;
      const name = fullToken.substring(1); // Remove %
      return {
        id,
        type: 'component',
        name,
        path: `%${name}`,
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [],
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    if (cst.children.functionDecl) {
      const fullToken = cst.children.functionDecl[0].children.FunctionToken[0].image;
      const name = fullToken.substring(1, fullToken.length - 2); // Remove $ and ()
      return {
        id,
        type: 'function',
        name,
        path: `$${name}()`,
        functionSignature: fullToken,
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [],
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    if (cst.children.variableDecl) {
      // Skip variable declarations - we don't track them in CoDoc
      return null;
    }

    if (cst.children.referenceDecl) {
      const fullToken = cst.children.referenceDecl[0].children.Reference[0].image;
      const name = fullToken.substring(1); // Remove @
      return {
        id,
        type: 'reference',
        name,
        path: fullToken,
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [name], // References are dependencies
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    if (cst.children.noteDecl) {
      const content = cst.children.noteDecl[0].children.Content[0].image;
      return {
        id,
        type: 'note',
        name: content.trim(),
        path: `#${content}`,
        content: content.trim(),
        lineNumber,
        column: indentLevel * this.indentUnit,
        dependencies: [],
        dependents: [],
        contentHash: this.calculateHash(originalText)
      };
    }

    return null;
  }

  /**
   * Attach node to tree using stack-based approach
   */
  private attachNodeToTree(
    node: SchemaNode,
    indentLevel: number,
    context: ParsingContext
  ): void {
    // Pop stack while top has indent >= current
    while (
      context.stack.length > 0 &&
      context.stack[context.stack.length - 1].indent >= indentLevel
    ) {
      context.stack.pop();
    }

    // Validate and find correct parent
    if (context.stack.length > 0) {
      const potentialParent = context.stack[context.stack.length - 1].node;

      // Check if valid parent-child relationship
      if (this.canBeChild(node.type, potentialParent.type)) {
        node.parent = potentialParent;
        if (!potentialParent.children) {
          potentialParent.children = [];
        }
        potentialParent.children.push(node);
      } else {
        // Invalid relationship - find correct parent or make top-level
        const validParent = this.findValidParent(node.type, context.stack);
        if (validParent) {
          node.parent = validParent.node;
          if (!validParent.node.children) {
            validParent.node.children = [];
          }
          validParent.node.children.push(node);
          context.validationMessages.push(
            `Line ${node.lineNumber}: Auto-corrected parent (${node.type} cannot be child of ${potentialParent.type})`
          );
        } else {
          // Make top-level
          context.validationMessages.push(
            `Line ${node.lineNumber}: Made top-level (no valid parent found)`
          );
        }
      }
    }

    // Add to stack and all nodes
    context.stack.push({ node, indent: indentLevel });
    context.allNodes.push(node);
  }

  /**
   * Check if childType can be child of parentType
   */
  private canBeChild(childType: string, parentType: string): boolean {
    const validRelationships: Record<string, string[]> = {
      directory: ['directory', 'file'],
      file: ['function', 'component', 'variable', 'reference', 'note'],
      function: [],
      component: [],
      variable: [],
      reference: [],
      note: []
    };

    return validRelationships[parentType]?.includes(childType) || false;
  }

  /**
   * Find valid parent from stack
   */
  private findValidParent(
    childType: string,
    stack: Array<{ node: SchemaNode; indent: number }>
  ): { node: SchemaNode; indent: number } | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (this.canBeChild(childType, stack[i].node.type)) {
        return stack[i];
      }
    }
    return null;
  }

  /**
   * Check if trimmed line is incomplete token
   */
  private isIncompleteToken(trimmed: string): boolean {
    return /^[$%@#!]{1,2}$/.test(trimmed);
  }

  /**
   * Calculate SHA-256 hash for content
   */
  private calculateHash(content: string): string {
    const normalized = content.trim().toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }
}

export const codocParser = new CodocParser();
