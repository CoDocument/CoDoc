/**
 * Main CODOC parser with dependency tracking
 * Builds hierarchical SchemaNode tree with validation
 * Supports freeform nodes for unrecognized content
 */

import { SchemaNode } from "../types.js";
import { CodocLexer } from "./lexer.js";
import { lineParser, CodocLineParser } from "./lineParser.js";
import * as crypto from "crypto";

interface ParsingContext {
  stack: Array<{ node: SchemaNode; indent: number }>;
  allNodes: SchemaNode[];
  nodeCounter: number;
  validationMessages: string[];
  unrecognizedNodes: SchemaNode[]; // Track freeform/unrecognized nodes
}

export class CodocParser {
  private indentUnit = 2; // 2 spaces per indent level

  /**
   * Parse CODOC content into SchemaNode tree with dependency tracking
   * Now supports freeform nodes for content that can't be parsed
   */
  parse(content: string): { nodes: SchemaNode[]; errors: string[]; unrecognizedNodes: SchemaNode[] } {
    const lines = content.split('\n');
    const context: ParsingContext = {
      stack: [],
      allNodes: [],
      nodeCounter: 0,
      validationMessages: [],
      unrecognizedNodes: []
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length || 0;
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        continue;
      }

      // Check if this is a comment line (starts with #)
      if (trimmed.startsWith('#')) {
        const indentLevel = Math.floor(leadingSpaces / this.indentUnit);
        const commentNode = this.createCommentNode(
          trimmed,
          lineIndex + 1,
          indentLevel,
          context
        );
        this.attachNodeToTree(commentNode, indentLevel, context);
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
          // Create freeform node for unrecognized content
          const freeformNode = this.createFreeformNode(
            trimmed, 
            lineIndex + 1, 
            indentLevel, 
            context,
            `Lexing error: ${lexResult.errors[0].message}`
          );
          this.attachNodeToTree(freeformNode, indentLevel, context);
          continue;
        }

        // Parse
        lineParser.input = lexResult.tokens;
        const cst = lineParser.line();

        if (lineParser.errors.length > 0) {
          if (this.isIncompleteToken(trimmed)) {
            continue;
          }
          // Create freeform node for unrecognized content
          const freeformNode = this.createFreeformNode(
            trimmed, 
            lineIndex + 1, 
            indentLevel, 
            context,
            `Parse error: ${lineParser.errors[0].message}`
          );
          this.attachNodeToTree(freeformNode, indentLevel, context);
          continue;
        }

        // Build node
        const node = this.buildNodeFromCST(cst, trimmed, lineIndex + 1, indentLevel, context);
        if (!node) {
          // If we couldn't build a typed node, create a freeform node
          const freeformNode = this.createFreeformNode(
            trimmed, 
            lineIndex + 1, 
            indentLevel, 
            context,
            'Could not determine node type'
          );
          this.attachNodeToTree(freeformNode, indentLevel, context);
          continue;
        }

        // Attach to tree
        this.attachNodeToTree(node, indentLevel, context);

      } catch (error) {
        // Create freeform node for unexpected errors
        const freeformNode = this.createFreeformNode(
          trimmed, 
          lineIndex + 1, 
          indentLevel, 
          context,
          `Unexpected error: ${error}`
        );
        this.attachNodeToTree(freeformNode, indentLevel, context);
      }
    }

    return {
      nodes: context.allNodes.filter(n => !n.parent),
      errors: context.validationMessages,
      unrecognizedNodes: context.unrecognizedNodes
    };
  }

  /**
   * Create a comment node for lines starting with #
   * Comments are preserved as-is and tracked in the structure
   */
  private createCommentNode(
    rawText: string,
    lineNumber: number,
    indentLevel: number,
    context: ParsingContext
  ): SchemaNode {
    const id = `comment_${context.nodeCounter++}`;
    const commentText = rawText.trim().substring(1).trim(); // Remove leading # and trim
    
    const node: SchemaNode = {
      id,
      type: 'comment',
      name: commentText || '(empty comment)',
      path: `comment_${lineNumber}`,
      lineNumber,
      column: indentLevel * this.indentUnit,
      dependencies: [],
      dependents: [],
      contentHash: this.calculateHash(rawText),
      isFreeform: true,
      isComment: true,
      originalText: rawText.trim(),
      content: commentText
    };
    
    context.allNodes.push(node);
    return node;
  }

  /**
   * Create a freeform node for unrecognized content
   * Preserves the content and marks it for linting
   */
  private createFreeformNode(
    rawText: string,
    lineNumber: number,
    indentLevel: number,
    context: ParsingContext,
    validationError: string
  ): SchemaNode {
    const id = `freeform_${context.nodeCounter++}`;
    const node: SchemaNode = {
      id,
      type: 'freeform',
      name: rawText.substring(0, 30) + (rawText.length > 30 ? '...' : ''),
      path: `freeform:${lineNumber}`,
      rawText,
      lineNumber,
      column: indentLevel * this.indentUnit,
      dependencies: [],
      dependents: [],
      contentHash: this.calculateHash(rawText),
      isUnrecognized: true,
      validationError,
      isPending: true
    };
    
    context.unrecognizedNodes.push(node);
    context.validationMessages.push(
      `Line ${lineNumber}: Unrecognized content preserved as freeform - ${validationError}`
    );
    
    return node;
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
        id: `dir_${name}`, // Temporary ID, will be updated when attached
        type: 'directory',
        name,
        path: name, // Will be updated when attached to tree
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
      const fileName = name + ext;
      return {
        id: `file_${name}`, // Temporary ID, will be updated when attached
        type: 'file',
        name: fileName,
        path: fileName, // Will be updated when attached to tree
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
        id: `component_${name}`, // Temporary ID, will be updated when attached
        type: 'component',
        name,
        path: `%${name}`, // Will be updated when attached to tree
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
        id: `function_${name}`, // Temporary ID, will be updated when attached
        type: 'function',
        name,
        path: `$${name}()`, // Will be updated when attached to tree
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
   * Now also updates path and ID to reflect full hierarchy
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
        
        // Update path based on parent
        this.updateNodePathAndId(node, potentialParent);
      } else {
        // Invalid relationship - find correct parent or make top-level
        const validParent = this.findValidParent(node.type, context.stack);
        if (validParent) {
          node.parent = validParent.node;
          if (!validParent.node.children) {
            validParent.node.children = [];
          }
          validParent.node.children.push(node);
          
          // Update path based on valid parent
          this.updateNodePathAndId(node, validParent.node);
          
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
   * Update node's path and ID based on parent hierarchy
   */
  private updateNodePathAndId(node: SchemaNode, parent: SchemaNode): void {
    if (node.type === 'directory') {
      // Build path from root to this directory
      node.path = this.buildFullPath(parent) + '/' + node.name;
      node.id = `dir_${node.path.replace(/\//g, '_')}`;
    } else if (node.type === 'file') {
      // File path is parent directory path + file name
      const parentPath = this.buildFullPath(parent);
      node.path = parentPath + '/' + node.name;
      node.id = `file_${node.path.replace(/[\/\.]/g, '_')}`;
    } else if (node.type === 'function' || node.type === 'component') {
      // Elements need their file's full path
      const filePath = this.buildFullPath(parent);
      node.path = `${filePath}#${node.name}`;
      node.id = `${filePath}:${node.name}`;
    }
  }

  /**
   * Build full path from root to given node
   */
  private buildFullPath(node: SchemaNode): string {
    const parts: string[] = [];
    let current: SchemaNode | undefined = node;
    
    while (current && current.name) { // Root nodes have empty name
      if (current.type === 'directory') {
        parts.unshift(current.name);
      } else if (current.type === 'file') {
        parts.unshift(current.name);
      }
      current = current.parent;
    }
    
    return parts.join('/');
  }

  /**
   * Check if childType can be child of parentType
   * Freeform nodes can be children of directories and files
   */
  private canBeChild(childType: string, parentType: string): boolean {
    const validRelationships: Record<string, string[]> = {
      directory: ['directory', 'file', 'freeform'],
      file: ['function', 'component', 'variable', 'reference', 'note', 'freeform'],
      function: ['freeform'],
      component: ['freeform'],
      variable: [],
      reference: [],
      note: [],
      freeform: ['freeform'] // Freeform can have freeform children
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
