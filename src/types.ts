/**
 * Core type definitions for CoDoc system
 */

/**
 * Diagnostic information for schema nodes (lint-style)
 */
export interface SchemaDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line?: number;
  column?: number;
  source?: string;
}

export interface SchemaNode {
  id: string;
  type: 'directory' | 'file' | 'function' | 'component' | 'reference' | 'note' | 'freeform' | 'comment';
  name: string;
  path: string;
  extension?: string;
  content?: string;
  children?: SchemaNode[];
  parent?: SchemaNode;
  lineNumber: number;
  column: number;
  endLine?: number;
  
  // Dependency tracking
  dependencies: string[]; // IDs of nodes this depends on
  dependents: string[]; // IDs of nodes that depend on this
  contentHash: string; // SHA-256 hash for rename detection
  
  // Metadata
  functionSignature?: string;
  componentProps?: string[];
  isExported?: boolean;
  
  // Freeform/unrecognized node tracking
  isFreeform?: boolean; // True if this is a freeform/unrecognized node
  isComment?: boolean; // True if this is a comment node (starts with #)
  isUnrecognized?: boolean; // True if this node couldn't be matched to codebase
  originalText?: string; // Original text for freeform nodes
  rawText?: string; // Alias for originalText (backwards compat)
  validationError?: string; // Error message explaining why unrecognized
  isPending?: boolean; // True if waiting for code generation
  diagnostics?: SchemaDiagnostic[]; // Lint-style diagnostics for this node
}

/**
 * Import information for tracking file dependencies
 */
export interface ImportInfo {
  source: string;           // Import path (e.g., './Login', 'react')
  specifiers: string[];     // Imported names (e.g., ['Login', 'LoginProps'])
  isDefault: boolean;       // Whether it's a default import
  isNamespace: boolean;     // Whether it's import * as X
  line: number;             // Line number in source file
}

export interface CodeElement {
  name: string;
  type: 'function' | 'component' | 'class' | 'interface' | 'type';
  filePath: string;
  line: number;
  column: number;
  isExported: boolean;
  content: string;
  
  // Dependency information
  imports: string[]; // Imported module paths
  exports: string[]; // Exported names
  calls: string[]; // Function/method calls within this element
  references: string[]; // Variable/type references
}

export interface FileStructure {
  path: string;
  exists: boolean;
  language: string;
  elements: CodeElement[];
  contentHash: string;
  lastModified: number;
  size: number;
  imports?: ImportInfo[]; // File-level import tracking
}

export interface CodebaseSnapshot {
  files: FileStructure[];
  directories: string[];
  timestamp: number;
  workspaceRoot: string;
  dependencyGraph: DependencyGraph;
}

export interface DependencyGraph {
  nodes: Record<string, DependencyNode>; // Changed from Map for JSON serialization
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  name: string;
  type: 'directory' | 'file' | 'function' | 'component' | 'class';
  filePath: string;
  upstream: string[]; // Dependencies (what this needs)
  downstream: string[]; // Dependents (what needs this)
}

export interface DependencyEdge {
  from: string; // Source node ID
  to: string; // Target node ID
  type: 'import' | 'call' | 'reference' | 'contains'; // Added 'contains' for hierarchy
  location: { file: string; line: number };
}

export interface StructuralDiff {
  added: SchemaNode[];
  removed: SchemaNode[];
  modified: SchemaNode[];
  renamed: RenamedNode[];
}

/**
 * Comprehensive AI-generated change classification
 * Only captures changes made by AI, not human edits
 */
export interface AIChange {
  id: string;
  type: 'add' | 'remove' | 'modify' | 'rename' | 'move' | 'refactor';
  
  // Change details
  element: {
    type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
    name: string;
    path: string;
  };
  
  // Location in CoDoc for decoration
  lineNumber: number;
  indentLevel: number;
  
  // Content for display
  content?: string;
  originalContent?: string;
  
  // For rename/move operations
  fromPath?: string;
  toPath?: string;
  fromName?: string;
  toName?: string;
  
  // For refactoring classification
  refactorType?: 'extract' | 'inline' | 'split' | 'merge' | 'restructure';
  
  // Metadata
  confidence: number; // 0-1 for fuzzy matches
  timestamp: number;
}

export interface RenamedNode {
  from: SchemaNode;
  to: SchemaNode;
  confidence: number; // 0-1 based on content hash match
}

export interface OpenCodeRequest {
  prompt: string;
  contextFiles: string[];
  workDir: string;
  model?: string;
}

export interface OpenCodeResponse {
  success: boolean;
  output: string;
  summary: string;
  error?: string;
}

export interface GenerationHistory {
  timestamp: number;
  prompt: string;
  response: string;
  summary: string;
  affectedFiles: string[];
}

export interface ImpactAnalysis {
  editedNode: string; // Node ID/path
  affectedNodes: string[]; // Node IDs/paths
  suggestions: SuggestedChange[];
  reasoning: string;
}

export interface SuggestedChange {
  codocSyntax: string;
  reason: string;
  insertLine: number;
  indentLevel: number;
}

export interface EditorState {
  content: string;
  parsedSchema: SchemaNode[];
  dependencyGraph: DependencyGraph;
  focusedNodeId: string | null;
  generationHistory: GenerationHistory[];
}

export interface VisualHierarchyRule {
  condition: 'editing-file' | 'editing-directory' | 'editing-function' | 'editing-component';
  fullOpacity: string[]; // Node selectors to keep at opacity 1.0
  dimmedOpacity: number; // Opacity for other nodes
}



export type FileDiff = {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}