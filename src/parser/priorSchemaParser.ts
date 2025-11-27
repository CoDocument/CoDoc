import type { ParserSchemaNode, PrefixType } from "../../components/Editor/types";
import type { SchemaNode } from "../../types/codoc";
import { SchemaLexer } from "./lexer";
import { lineParser } from "./miniLineParser";
// import { IToken } from "chevrotain";

export class SchemaParserService {
  private validationErrors: string[] = [];
  private indentUnit = 2; // CoDoc standard: 2 spaces per level

  parse(content: string): SchemaNode[] {
    this.validationErrors = [];
    const lines = content.split(/\r?\n/);
    const root: SchemaNode[] = [];
    const stack: { node: SchemaNode; indent: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indentMatch = /^(\s+)/.exec(line);
      let leadingSpaces = indentMatch ? indentMatch[1].length : 0;
      const originalLeadingSpaces = leadingSpaces; // Store original for validation messages
      const indentLevel = Math.floor(leadingSpaces / this.indentUnit);

      const trimmed = line.slice(leadingSpaces).trim();
      // If empty => skip
      if (!trimmed) {
        continue;
      }

      // Validate indent consistency (must be multiple of indentUnit)
      if (leadingSpaces % this.indentUnit !== 0) {
        this.validationErrors.push(
          `Line ${i + 1}: Indentation should be multiples of ${this.indentUnit} spaces. Found ${leadingSpaces} spaces.`
        );
      }

      // Tokenize the trimmed line
      const lexResult = SchemaLexer.tokenize(trimmed);
      
      // Skip lines with lexing errors (incomplete tokens like just "$" or "%")
      if (lexResult.errors.length > 0) {
        // Check if this is just an incomplete token that we should ignore
        if (trimmed === '$' || trimmed === '%' || trimmed === '@' || trimmed === '#' ||
            trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('@') || trimmed.startsWith('#')) {
          continue; // Skip incomplete tokens, don't throw error
        }
        
        throw new Error(
          `Lexing errors on line ${i + 1}: ${lexResult.errors
            .map((e: any) => e.message)
            .join(", ")}`
        );
      }

      // Parse with miniLineParser
      lineParser.input = lexResult.tokens;
      const cst = lineParser.statement();
      if (lineParser.errors.length > 0) {
        // Check if this is just an incomplete token that we should ignore
        if (trimmed === '$' || trimmed === '%' || trimmed === '@' || trimmed === '#' ||
            trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('@') || trimmed.startsWith('#')) {
          continue; // Skip incomplete tokens, don't throw error
        }
        
        throw new Error(
          `Parsing errors on line ${i + 1}: ${lineParser.errors
            .map((e: any) => e.message)
            .join("\n")}`
        );
      }

      // Build the node
      const parserNode = this.buildNodeFromLineCst(cst);
      if (!parserNode) {
        // Possibly an empty line / no recognized content
        continue;
      }

      // Convert ParserSchemaNode to SchemaNode format
      const node = this.convertToSchemaNode(parserNode, i, leadingSpaces);

      // Decide how to attach this node using the stack
      // 1. While the top of the stack has indent >= current line's indent => pop
      while (
        stack.length > 0 &&
        leadingSpaces <= stack[stack.length - 1].indent
      ) {
        stack.pop();
      }

      // 2. Validate and correct structure
      let finalParent: SchemaNode | null = null;
      
      if (stack.length > 0) {
        const potentialParent = stack[stack.length - 1].node;
        
        // Check if this is a valid parent-child relationship
        if (this.isValidParentChild(potentialParent, node, i + 1)) {
          finalParent = potentialParent;
        } else {
          // Invalid relationship - find correct parent or make top-level
          while (stack.length > 0) {
            const candidate = stack[stack.length - 1].node;
            if (this.isValidParentChild(candidate, node, i + 1)) {
              finalParent = candidate;
              break;
            }
            stack.pop();
          }
          
          // If we found a valid parent, recalculate indentation
          if (finalParent) {
            const parentStackEntry = stack[stack.length - 1];
            leadingSpaces = this.calculateExpectedIndent(finalParent, parentStackEntry.indent);
            
            if (originalLeadingSpaces !== leadingSpaces) {
              this.validationErrors.push(
                `Line ${i + 1}: Auto-corrected indentation for ${node.type} "${node.name}" from ${originalLeadingSpaces} to ${leadingSpaces} spaces`
              );
            }
          } else {
            // Make it top-level
            leadingSpaces = 0;
            if (originalLeadingSpaces !== 0) {
              this.validationErrors.push(
                `Line ${i + 1}: Auto-corrected ${node.type} "${node.name}" to top-level (from ${originalLeadingSpaces} spaces)`
              );
            }
          }
        }
      }

      // Attach the node to its parent or root
      if (finalParent) {
        // build a path - normalize to avoid duplication
        const parentPath = finalParent.path || '';
        const nodeName = node.name || '';
        const nodeExtension = node.extension || '';
        
        // Remove leading slash from parent path to avoid double slashes
        const cleanParentPath = parentPath.startsWith('/') ? parentPath : `/${parentPath}`;
        node.path = `${cleanParentPath}/${nodeName}${nodeExtension}`.replace(/\/+/g, '/');

        finalParent.children = finalParent.children || [];
        finalParent.children.push(node);
        
        // Set parent relationship
        node.parent = finalParent;
      } else {
        // top-level node
        if (node.type === "directory" || node.type === "file") {
          const nodeName = node.name || '';
          const nodeExtension = node.extension || '';
          node.path = `/${nodeName}${nodeExtension}`.replace(/\/+/g, '/');
        }
        root.push(node);
      }

      // 3. If node can have children => push it on stack
      if (node.type === "directory" || node.type === "file") {
        stack.push({
          node,
          indent: leadingSpaces // Use corrected indentation
        });
      }
    }

    // Log validation errors if any
    if (this.validationErrors.length > 0) {
      console.warn('⚠️ Schema validation errors:', this.validationErrors);
    }

    return root;
  }

  /**
   * Calculate expected indentation based on CoDoc rules
   */
  private calculateExpectedIndent(parent: SchemaNode, parentIndent: number): number {
    switch (parent.type) {
      case 'directory':
      case 'file':
        // Directories and files expect children at +1 level
        return parentIndent + this.indentUnit;
      
      case 'function':
      case 'component':
      case 'variable':
      case 'reference':
      case 'tool':
      case 'note':
        // These don't have children, so return same level (siblings)
        return parentIndent;
      
      default:
        return parentIndent + this.indentUnit;
    }
  }

  /**
   * Validate parent-child relationships
   */
  private isValidParentChild(parent: SchemaNode, child: SchemaNode, lineNumber: number): boolean {
    // Files cannot have directories as children
    if (parent.type === 'file' && child.type === 'directory') {
      this.validationErrors.push(`Line ${lineNumber}: Cannot place directory "${child.name}" under file "${parent.name}"`);
      return false;
    }

    // Files cannot have files as children
    if (parent.type === 'file' && child.type === 'file') {
      this.validationErrors.push(`Line ${lineNumber}: Cannot place file "${child.name}" under file "${parent.name}"`);
      return false;
    }

    // Functions and components should only be under files
    if ((child.type === 'function' || child.type === 'component') && parent.type !== 'file') {
      this.validationErrors.push(`Line ${lineNumber}: ${child.type} "${child.name}" should be placed under a file, not under ${parent.type} "${parent.name}"`);
      return false;
    }

    // Functions cannot have other functions as children
    if (parent.type === 'function' && (child.type === 'function' || child.type === 'component' || child.type === 'file' || child.type === 'directory')) {
      this.validationErrors.push(`Line ${lineNumber}: Cannot place ${child.type} "${child.name}" under function "${parent.name}"`);
      return false;
    }

    // Components cannot have other components/functions as children (unless they're props/methods)
    if (parent.type === 'component' && (child.type === 'function' || child.type === 'component' || child.type === 'file' || child.type === 'directory')) {
      this.validationErrors.push(`Line ${lineNumber}: Cannot place ${child.type} "${child.name}" under component "${parent.name}"`);
      return false;
    }

    return true;
  }

  /**
   * Get validation errors from the last parse
   */
  getValidationErrors(): string[] {
    return [...this.validationErrors];
  }

  /**
   * Extract a function name from a $function() token
   */
  private extractFunctionName(funcToken: string): string {
    // Remove the $ and () from $function()
    return funcToken.slice(1, -2);
  }

  /**
   * Extract a component name from a %component token
   */
  private extractComponentName(componentToken: string): string {
    // Remove the % from %component
    return componentToken.slice(1);
  }

  /**
   * Extract a variable name from a varVariable token
   */
  private extractVariableName(variableToken: string): string {
    // Remove the var from varVariable
    return variableToken.slice(3);
  }

  /**
   * Extract a reference from a @reference token
   */
  private extractReference(referenceToken: string): string {
    // Remove the @ from @reference
    return referenceToken.slice(1);
  }

  /**
   * Parse a value from CST
   */
  private parseValue(valueCst: any): string | number | boolean {
    if (!valueCst?.children) return "";
    
    if (valueCst.children.StringLiteral) {
      // Remove quotes from string literal
      const str = valueCst.children.StringLiteral[0].image;
      return str.slice(1, -1);
    } else if (valueCst.children.NumberLiteral) {
      return parseFloat(valueCst.children.NumberLiteral[0].image);
    } else if (valueCst.children.BooleanLiteral) {
      return valueCst.children.BooleanLiteral[0].image === "true";
    } else if (valueCst.children.Identifier) {
      return valueCst.children.Identifier[0].image;
    }
    
    return "";
  }

  /**
   * Parse JSON object from CST
   */
  private parseJsonObject(jsonCst: any): Record<string, any> {
    // Simplified JSON parsing for now
    // In a real implementation, you'd recursively parse the JSON structure
    return {};
  }

  /**
   * Convert ParserSchemaNode to SchemaNode format with proper ID and positioning
   */
  private convertToSchemaNode(parserNode: ParserSchemaNode, lineNumber: number, column: number): SchemaNode {
    const id = `${parserNode.type}-${lineNumber}-${parserNode.name || Date.now()}`;
    
    // Use the path as-is if it exists, otherwise build a simple path
    let nodePath = parserNode.path;
    if (!nodePath && (parserNode.type === 'directory' || parserNode.type === 'file')) {
      nodePath = `${parserNode.name || ''}${parserNode.extension || ''}`;
    }
    
    return {
      id,
      type: this.mapParserTypeToSchemaType(parserNode.type),
      name: parserNode.name || '',
      path: nodePath || parserNode.name || '',
      extension: parserNode.extension,
      content: parserNode.content,
      children: parserNode.children?.map((child: ParserSchemaNode, index: number) => 
        this.convertToSchemaNode(child, lineNumber, column + 2)
      ) || [],
      lineNumber,
      column: 0,
      description: parserNode.suggestion || parserNode.feedback || parserNode.content,
      functionSignature: parserNode.type === 'function' ? `${parserNode.name}()` : undefined
    };
  }

  /**
   * Map parser node types to SchemaNode types
   */
  private mapParserTypeToSchemaType(parserType: string): SchemaNode['type'] {
    switch (parserType) {
      case 'feedforward':
        return 'suggestion';
      case 'user_note':
        return 'note';
      case 'tool_trigger':
        return 'tool';
      default:
        return parserType as SchemaNode['type'];
    }
  }

  /**
   * Read the CST from lineParser.statement() and figure out which 
   * type of node was parsed.
   */
  private buildNodeFromLineCst(cst: any): ParserSchemaNode | null {
    if (!cst.children) return null;

    if (cst.children.directoryDecl) {
      // e.g. /src
      const dirCst = cst.children.directoryDecl[0];
      const nameToken = dirCst.children.Identifier[0];
      return {
        type: "directory",
        name: nameToken.image,
        children: []
      };
    } else if (cst.children.fileDecl) {
      // e.g. a.tsx
      const fileCst = cst.children.fileDecl[0];
      const nameToken = fileCst.children.Identifier[0];
      const extToken = fileCst.children.FileExtension[0];
      return {
        type: "file",
        name: nameToken.image,
        extension: extToken.image,
        children: []
      };
    } else if (cst.children.prefixedStatement) {
      // Handle prefixed statements like <<%Button or >>$function()
      return this.buildPrefixedNode(cst.children.prefixedStatement[0]);
    } else if (cst.children.componentDecl) {
      // e.g. %Button
      const componentCst = cst.children.componentDecl[0];
      const componentToken = componentCst.children.Component[0];
      const componentName = this.extractComponentName(componentToken.image);
      
      return {
        type: "component",
        name: componentName,
        prefix: 'none'
      };
    } else if (cst.children.functionDecl) {
      // e.g. $function()
      const funcCst = cst.children.functionDecl[0];
      const funcToken = funcCst.children.FunctionToken[0];
      const functionName = this.extractFunctionName(funcToken.image);
      
      return {
        type: "function",
        name: functionName,
        prefix: 'none'
      };
    } else if (cst.children.variableDecl) {
      // e.g. varApiUrl = "value"
      const varCst = cst.children.variableDecl[0];
      const varToken = varCst.children.Variable[0];
      const variableName = this.extractVariableName(varToken.image);
      
      let value: string | number | boolean | undefined;
      if (varCst.children.value) {
        value = this.parseValue(varCst.children.value[0]);
      }
      
      return {
        type: "variable",
        name: variableName,
        value: value,
        prefix: 'none'
      };
    } else if (cst.children.referenceDecl) {
      // e.g. @frontend.components.Button
      const refCst = cst.children.referenceDecl[0];
      const refToken = refCst.children.Reference[0];
      const reference = this.extractReference(refToken.image);
      
      return {
        type: "reference",
        name: reference,
        dotted: reference,
        prefix: 'none'
      };
    } else if (cst.children.userNoteDecl) {
      // e.g. # This is a user note (human-only comment)
      const noteCst = cst.children.userNoteDecl[0];
      let content = "";
      if (noteCst.children.Content) {
        content = noteCst.children.Content[0].image;
      }
      
      return {
        type: "user_note",
        name: "note",
        content: content,
        prefix: 'none'
      };
    } else if (cst.children.toolTriggerDecl) {
      // e.g. !!generate({"type": "component"})
      const toolCst = cst.children.toolTriggerDecl[0];
      const toolName = toolCst.children.Identifier[0].image;
      
      let toolParams: Record<string, any> = {};
      if (toolCst.children.jsonObject) {
        toolParams = this.parseJsonObject(toolCst.children.jsonObject[0]);
      }
      
      return {
        type: "tool_trigger",
        name: toolName,
        toolParams: toolParams,
        prefix: 'none'
      };
    }

    return null; // possibly blank line
  }

  /**
   * Build node from prefixed statement (like <<%Button or >>$function())
   */
  private buildPrefixedNode(prefixedCst: any): ParserSchemaNode | null {
    if (!prefixedCst.children) return null;

    let prefixType: PrefixType = 'none';
    let prefixableStatement: any = null;

    // Determine prefix type
    if (prefixedCst.children.SuggestionPrefix) {
      prefixType = 'suggestion';
      prefixableStatement = prefixedCst.children.prefixableStatement[0];
    } else if (prefixedCst.children.FeedbackPrefix) {
      prefixType = 'feedback';
      prefixableStatement = prefixedCst.children.prefixableStatement[0];
    }

    if (!prefixableStatement?.children) return null;

    // Parse the underlying statement
    let baseNode: ParserSchemaNode | null = null;

    if (prefixableStatement.children.componentDecl) {
      const componentCst = prefixableStatement.children.componentDecl[0];
      const componentToken = componentCst.children.Component[0];
      const componentName = this.extractComponentName(componentToken.image);
      
      baseNode = {
        type: "component",
        name: componentName,
        baseType: "component"
      };
    } else if (prefixableStatement.children.functionDecl) {
      const funcCst = prefixableStatement.children.functionDecl[0];
      const funcToken = funcCst.children.FunctionToken[0];
      const functionName = this.extractFunctionName(funcToken.image);
      
      baseNode = {
        type: "function",
        name: functionName,
        baseType: "function"
      };
    } else if (prefixableStatement.children.variableDecl) {
      const varCst = prefixableStatement.children.variableDecl[0];
      const varToken = varCst.children.Variable[0];
      const variableName = this.extractVariableName(varToken.image);
      
      let value: string | number | boolean | undefined;
      if (varCst.children.value) {
        value = this.parseValue(varCst.children.value[0]);
      }
      
      baseNode = {
        type: "variable",
        name: variableName,
        value: value,
        baseType: "variable"
      };
    } else if (prefixableStatement.children.referenceDecl) {
      const refCst = prefixableStatement.children.referenceDecl[0];
      const refToken = refCst.children.Reference[0];
      const reference = this.extractReference(refToken.image);
      
      baseNode = {
        type: "reference",
        name: reference,
        dotted: reference,
        baseType: "reference"
      };
    } else if (prefixableStatement.children.fileDecl) {
      const fileCst = prefixableStatement.children.fileDecl[0];
      const nameToken = fileCst.children.Identifier[0];
      const extToken = fileCst.children.FileExtension[0];
      
      baseNode = {
        type: "file",
        name: nameToken.image,
        extension: extToken.image,
        baseType: "file"
      };
    } else if (prefixableStatement.children.Content) {
      // Content like << Add validation or >> Added feature
      const content = prefixableStatement.children.Content[0].image;
      
      baseNode = {
        type: prefixType === 'suggestion' ? "feedforward" : "feedback",
        name: prefixType === 'suggestion' ? "suggestion" : "feedback",
        content: content,
        suggestion: prefixType === 'suggestion' ? content : undefined,
        feedback: prefixType === 'feedback' ? content : undefined
      };
    }

    if (baseNode) {
      baseNode.prefix = prefixType;
      baseNode.isAccepted = false; // Suggestions start as not accepted
    }

    return baseNode;
  }
}