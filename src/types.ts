/**
 * Core type definitions for CoDoc system
 */

export interface SchemaNode {
  id: string;
  type: 'directory' | 'file' | 'function' | 'component' | 'reference' | 'note';
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
