export interface SchemaNode {
  id: string;
  type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference' | 'note';
  name: string;
  path: string;
  extension?: string;
  content?: string;
  children?: SchemaNode[];
  parent?: SchemaNode;
  lineNumber: number;
  column: number;
  endLine?: number;
  dependencies: string[];
  dependents: string[];
  contentHash: string;
}

export interface SuggestedChange {
  codocSyntax: string;
  reason: string;
  insertLine: number;
  indentLevel: number;
}
