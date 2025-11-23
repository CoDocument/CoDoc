# CoDoc Extension - Architecture

## Overview

Lightweight VSCode extension for authoring CODOC structures with dependency-aware code generation via OpenCode CLI.

## Core Components

### 1. Parser (Chevrotain-based)

**lexer.ts** - Token definitions:
- Directory `/`, File extension, Component `%`, Function `$()`, Variable, Reference `@`, UserNote `#`

**lineParser.ts** - CST parser:
- Grammar rules for each CODOC element type
- Single CST (Concrete Syntax Tree)

**codocParser.ts** - Main parser:
- Converts CST → SchemaNode AST
- Stack-based tree building with parent-child validation
- SHA-256 content hashing for rename detection

**indentCalculator.ts** - Parser-driven indentation:
- Single source of truth for indent rules
- Directory/file +1 level, function/component same level

### 2. Analysis Engine

**AnalysisEngine.ts** - Codebase scanning:

```typescript
scanCodebase() → CodebaseSnapshot {
  // Scans src/**/*.{ts,tsx,js,jsx,py,java}
  // Excludes node_modules, dist, build, test
  
  files.forEach(file => {
    analyzeFile(file) → FileStructure {
      extractCodeElements(code) → CodeElement[] {
        // Babel traverse:
        // - FunctionDeclaration → functions
        // - VariableDeclarator → arrow functions
        // - ClassDeclaration → components
        // Extracts: imports[], calls[], references[]
      }
    }
  })
  
  buildDependencyGraph(files) → DependencyGraph {
    // Map<string, DependencyNode> with upstream/downstream
    // DependencyEdge[] linking import/call/reference relationships
  }
  
  constructCodoc(snapshot) → SchemaNode[] {
    // Convert FileStructure[] to hierarchical tree
    // Attach dependency data to nodes
  }
}
```

**Direct dependency tracking only** (no transitive closure).

### 3. Structural Diff Engine

**StructuralDiffEngine.ts** - Content-hash-based comparison:

```typescript
compare(oldNodes, newNodes) → StructuralDiff {
  // Build hash maps: Map<hash, SchemaNode>
  
  // Detect:
  // - Added: New hash, new path
  // - Removed: Hash gone, path gone
  // - Modified: Same path, different hash
  // - Renamed: Same hash, different path (confidence: 1.0)
  
  // Special handling:
  // Relocations show parent dir added, not file duplicated
}
```

### 4. OpenCode Service

**OpenCodeService.ts** - CLI wrapper:

```typescript
checkAuth() → boolean {
  // Run: opencode whoami
}

generate(request) → OpenCodeResponse {
  // 1. Write prompt to /tmp/codoc_prompt_XXX.txt
  // 2. Run: opencode generate --model gpt-4 --prompt-file ...
  // 3. Stream output via terminal
  // 4. Extract summary (SUMMARY section or last paragraph fallback)
}

storeHistory(workDir, prompt, response, summary, files) {
  // Save to .codoc/history.json (keep last 50)
}
```

### 5. Impact Analysis Service

**ImpactAnalysisService.ts** - Edit-driven suggestions:

```typescript
analyzeEditImpact(editedNode, graph, lastSummary, apiKey, onSuggestions) {
  // Skip if no dependencies/dependents
  
  // Debounce 2.5s
  
  // Build context:
  // - Upstream: What this node imports/calls
  // - Downstream: What calls this node
  
  // Call OpenAI API:
  // Prompt: "User edited X which depends on Y,Z. Last gen changed A,B.
  //          What CODOC changes needed?"
  
  // Parse response → SuggestedChange[] {
  //   codocSyntax, reason, insertLine, indentLevel
  // }
}
```

### 6. Custom Editor Provider

**CodocEditorProvider.ts** - VSCode integration:

```typescript
resolveCustomTextEditor(document, webviewPanel) {
  // Setup webview with React UI
  
  // Handle messages:
  // - contentChanged: Update document
  // - scanCodebase: Run AnalysisEngine
  // - generateCode: Run OpenCodeService
  // - analyzeImpact: Run ImpactAnalysisService
  // - openFile: Jump to file location
  
  // Send messages to webview:
  // - contentUpdate: New document content
  // - codebaseScanned: Dependency graph
  // - generationComplete: OpenCode summary
  // - suggestions: Impact analysis results
}
```

### 7. Webview UI

**CodocEditor.tsx** - React component:

- CodeMirror editor with CODOC syntax
- File-explorer styling (vertical guides, sticky headers, opacity-based focus)
- Suggestion widgets showing inline
- Buttons: Scan Codebase, Generate Code

**Visual Hierarchy Rules**:
- Edited node + dependencies = opacity 1.0
- Other nodes = opacity 0.4

## Data Flow

### Codebase Scan Flow

```
User clicks "Scan" 
  → CodocEditorProvider.scanCodebase()
  → AnalysisEngine.scanCodebase()
  → Babel traverse extracts imports/calls/references
  → buildDependencyGraph() creates Map<string, DependencyNode>
  → WebView receives snapshot
```

### Code Generation Flow

```
User enters prompt
  → CodocEditorProvider.generateCode()
  → OpenCodeService.generate()
  → Write prompt to /tmp file
  → Terminal: opencode generate --prompt-file ...
  → Extract summary (SUMMARY or last paragraph)
  → Store in .codoc/history.json
  → WebView receives summary
```

### Edit Impact Flow

```
User edits CODOC node
  → WebView sends analyzeImpact message
  → ImpactAnalysisService.analyzeEditImpact()
  → Check dependencies (skip if none)
  → Debounce 2.5s
  → Build upstream/downstream context
  → Call OpenAI API
  → Parse suggestions
  → WebView displays inline suggestions
```

## Type System

**SchemaNode** - Enhanced AST node:
```typescript
{
  type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference' | 'note'
  dependencies: string[]  // What this depends on
  dependents: string[]    // What depends on this
  contentHash: string     // SHA-256 for rename detection
}
```

**DependencyGraph**:
```typescript
{
  nodes: Map<string, DependencyNode> {
    upstream: string[]    // Dependencies
    downstream: string[]  // Dependents
  }
  edges: DependencyEdge[] {
    type: 'import' | 'call' | 'reference'
  }
}
```

**StructuralDiff**:
```typescript
{
  added: SchemaNode[]
  removed: SchemaNode[]
  modified: SchemaNode[]
  renamed: RenamedNode[] {
    from: SchemaNode
    to: SchemaNode
    confidence: number  // 1.0 for perfect hash match
  }
}
```

## Design Decisions

### Why Direct Dependencies Only?
- Simpler and faster than transitive closure
- User controls structure explicitly
- Avoids false positives in impact analysis

### Why Content Hashing?
- SHA-256 normalized code enables rename detection
- Compare hashes between old/new structures
- Same hash + different path = rename (confidence 1.0)

### Why Debounced Impact Analysis?
- Avoid excessive API calls while user types
- 2.5s delay allows user to complete thought
- Only triggers if dependencies exist

### Why OpenCode CLI vs Direct API?
- OpenCode handles auth, model selection, context management
- Terminal integration provides visibility
- Summary extraction standardized via fallback

### Why Parser-Driven Indentation?
- Single source of truth (no duplication)
- UI and validation use same logic
- Prevents drift between display and rules

## Extension Points

### Adding Language Support

1. Update AnalysisEngine file patterns
2. Add language-specific Babel plugins
3. Map language constructs to CodeElement types

### Custom Suggestion Widgets

1. Extend SuggestedChange interface
2. Update ImpactAnalysisService prompt
3. Add React component in webview

### Alternative Code Generation

1. Implement new service similar to OpenCodeService
2. Update CodocEditorProvider message handling
3. Add configuration option

## Performance Considerations

- **Codebase scan**: ~1-2s for 100 files (Babel parsing)
- **Dependency graph**: O(n) nodes + O(m) edges
- **Impact analysis**: Debounced + cached
- **Content hashing**: SHA-256 is fast (~1ms per file)
- **Structural diff**: O(n log n) with hash maps

## Future Enhancements

- [ ] Transitive dependency visualization
- [ ] Multi-cursor editing
- [ ] Undo/redo for generated code
- [ ] Diff view for structural changes
- [ ] Custom language support plugins
- [ ] Workspace-level CODOC templates
