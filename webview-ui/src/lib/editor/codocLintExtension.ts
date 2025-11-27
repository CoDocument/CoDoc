/**
 * CodeMirror lint extension for CoDoc
 * 
 * Provides squiggly line diagnostics for:
 * - Freeform/unrecognized content
 * - Validation errors in schema nodes
 * - Structural issues
 */

import { linter, Diagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { SchemaNode } from "../../types";

export interface CodocDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  actions?: Array<{
    name: string;
    apply: (view: EditorView, from: number, to: number) => void;
  }>;
}

// State to hold diagnostics from the extension
let pendingDiagnostics: CodocDiagnostic[] = [];

/**
 * Set diagnostics to be shown in the editor
 * Call this when the schema changes and new diagnostics are computed
 */
export function setCodocDiagnostics(diagnostics: CodocDiagnostic[]): void {
  pendingDiagnostics = diagnostics;
}

/**
 * Clear all diagnostics
 */
export function clearCodocDiagnostics(): void {
  pendingDiagnostics = [];
}

/**
 * Build diagnostics from schema nodes
 * Identifies freeform nodes and nodes with diagnostics
 */
export function buildDiagnosticsFromSchema(
  schema: SchemaNode[],
  docText: string
): CodocDiagnostic[] {
  const diagnostics: CodocDiagnostic[] = [];
  const lines = docText.split('\n');
  console.log('[codocLintExtension] Processing schema with', schema.length, 'root nodes');
  
  function processNode(node: SchemaNode, parent?: SchemaNode): void {
    console.log('[codocLintExtension] Processing node:', node.type, node.name || node.path, 'parent:', parent?.type, parent?.name);
    
    // Validate structural rules
    if (parent) {
      const validationError = validateParentChild(parent, node);
      if (validationError) {
        console.log('[codocLintExtension] Validation error:', validationError);
        const lineIndex = findLineForNode(node, lines);
        if (lineIndex !== -1) {
          const { from, to } = getLineRange(lines, lineIndex);
          diagnostics.push({
            from,
            to,
            severity: 'error',
            message: validationError,
            source: 'codoc-structure'
          });
        }
      }
    }
    
    // Handle freeform/unrecognized nodes
    if (node.type === 'freeform' || node.isUnrecognized) {
      console.log('[codocLintExtension] Found freeform/unrecognized node:', node.name || node.originalText);
      const lineIndex = findLineForNode(node, lines);
      if (lineIndex !== -1) {
        const { from, to } = getLineRange(lines, lineIndex);
        diagnostics.push({
          from,
          to,
          severity: 'warning',
          message: node.type === 'freeform' 
            ? `Unrecognized content: "${node.name || node.originalText || 'unknown'}". This line will be preserved but not synced.`
            : `Unrecognized element: "${node.name}"`,
          source: 'codoc-parser'
        });
      }
    }
    
    // Handle nodes with explicit diagnostics
    if (node.diagnostics && node.diagnostics.length > 0) {
      for (const diag of node.diagnostics) {
        const lineIndex = diag.line !== undefined ? diag.line - 1 : findLineForNode(node, lines);
        if (lineIndex !== -1 && lineIndex < lines.length) {
          const { from, to } = getLineRange(lines, lineIndex);
          diagnostics.push({
            from,
            to,
            severity: mapSeverity(diag.severity),
            message: diag.message,
            source: diag.source || 'codoc'
          });
        }
      }
    }
    
    // Recursively process children
    if (node.children) {
      for (const child of node.children) {
        processNode(child, node);
      }
    }
  }
  
  for (const node of schema) {
    processNode(node);
  }
  
  console.log('[codocLintExtension] Total diagnostics:', diagnostics.length);
  
  return diagnostics;
}

/**
 * Validate parent-child relationships based on CoDoc rules
 * Returns error message if invalid, null if valid
 */
function validateParentChild(parent: SchemaNode, child: SchemaNode): string | null {
  // Files cannot have directories as children
  if (parent.type === 'file' && child.type === 'directory') {
    return `Cannot place directory "${child.name}" under file "${parent.name}"`;
  }

  // Files cannot have files as children
  if (parent.type === 'file' && child.type === 'file') {
    return `Cannot place file "${child.name}" under file "${parent.name}"`;
  }

  // Functions and components should only be under files
  if ((child.type === 'function' || child.type === 'component') && parent.type !== 'file') {
    return `${child.type} "${child.name}" should be placed under a file, not under ${parent.type} "${parent.name}"`;
  }

  // Functions cannot have other functions as children
  if (parent.type === 'function' && (child.type === 'function' || child.type === 'component' || child.type === 'file' || child.type === 'directory')) {
    return `Cannot place ${child.type} "${child.name}" under function "${parent.name}"`;
  }

  // Components cannot have other components/functions as children
  if (parent.type === 'component' && (child.type === 'function' || child.type === 'component' || child.type === 'file' || child.type === 'directory')) {
    return `Cannot place ${child.type} "${child.name}" under component "${parent.name}"`;
  }

  return null;
}

/**
 * Find the line index for a node based on its path or name
 */
function findLineForNode(node: SchemaNode, lines: string[]): number {
  // If we have lineNumber info, use it
  if ((node as any).lineNumber !== undefined) {
    return (node as any).lineNumber - 1;
  }
  
  // Try to find by path or name
  const searchTerms = [
    node.path,
    node.name,
    node.originalText
  ].filter(Boolean);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const term of searchTerms) {
      if (term && line.includes(term)) {
        return i;
      }
    }
  }
  
  return -1;
}

/**
 * Get character range for a line
 */
function getLineRange(lines: string[], lineIndex: number): { from: number; to: number } {
  let from = 0;
  for (let i = 0; i < lineIndex; i++) {
    from += lines[i].length + 1; // +1 for newline
  }
  const to = from + lines[lineIndex].length;
  return { from, to };
}

/**
 * Map diagnostic severity to CodeMirror severity
 */
function mapSeverity(severity?: string): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'hint':
      return 'hint';
    default:
      return 'warning';
  }
}

/**
 * Create the CodeMirror linter extension for CoDoc
 * This linter uses manually set diagnostics (from schema parsing)
 */
export function createCodocLinter(): Extension {
  return linter((view: EditorView): Diagnostic[] => {
    // Convert our diagnostics to CodeMirror Diagnostic format
    return pendingDiagnostics.map(diag => ({
      from: Math.max(0, Math.min(diag.from, view.state.doc.length)),
      to: Math.max(0, Math.min(diag.to, view.state.doc.length)),
      severity: diag.severity,
      message: diag.message,
      source: diag.source,
      actions: diag.actions
    }));
  }, {
    delay: 500  // Debounce for 500ms to avoid flicker
  });
}

/**
 * Create a more reactive linter that parses content directly
 * Use this if you want diagnostics to update immediately on edit
 */
export function createReactiveCodocLinter(
  parseSchema: (content: string) => SchemaNode[]
): Extension {
  return linter((view: EditorView): Diagnostic[] => {
    const content = view.state.doc.toString();
    
    try {
      const schema = parseSchema(content);
      const diagnostics = buildDiagnosticsFromSchema(schema, content);
      
      return diagnostics.map(diag => ({
        from: Math.max(0, Math.min(diag.from, view.state.doc.length)),
        to: Math.max(0, Math.min(diag.to, view.state.doc.length)),
        severity: diag.severity,
        message: diag.message,
        source: diag.source
      }));
    } catch (error) {
      // If parsing fails completely, show a general error
      console.warn('CoDoc lint: parsing error', error);
      return [{
        from: 0,
        to: Math.min(100, view.state.doc.length),
        severity: 'error',
        message: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: 'codoc-parser'
      }];
    }
  }, {
    delay: 750  // Slightly longer delay for full re-parse
  });
}

/**
 * Utility to create a linter with custom styling
 */
export function createStyledCodocLinter(options?: {
  errorColor?: string;
  warningColor?: string;
  infoColor?: string;
}): Extension[] {
  const {
    errorColor = '#ef4444',
    warningColor = '#f59e0b',
    infoColor = '#3b82f6'
  } = options || {};
  
  return [
    createCodocLinter(),
    EditorView.baseTheme({
      ".cm-lintRange-error": {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23${errorColor.slice(1)}' fill='none' stroke-width='1.2'/></svg>")`,
      },
      ".cm-lintRange-warning": {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23${warningColor.slice(1)}' fill='none' stroke-width='1.2'/></svg>")`,
      },
      ".cm-lintRange-info": {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23${infoColor.slice(1)}' fill='none' stroke-width='1.2'/></svg>")`,
      },
      ".cm-tooltip-lint": {
        backgroundColor: "#1f2937",
        color: "#f3f4f6",
        border: "1px solid #374151",
        borderRadius: "6px",
        padding: "8px 12px",
        fontSize: "13px",
        maxWidth: "400px",
        boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)"
      },
      ".cm-lint-marker-error": {
        content: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23${errorColor.slice(1)}'><circle cx='8' cy='8' r='6'/></svg>")`
      },
      ".cm-lint-marker-warning": {
        content: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23${warningColor.slice(1)}'><polygon points='8,2 14,14 2,14'/></svg>")`
      }
    })
  ];
}
