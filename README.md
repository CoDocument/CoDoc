# CoDoc

CoDoc is a lightweight VS Code extension for authoring CODOC structures and driving dependency-aware code generation through the OpenCode CLI. It gives you a file-explorer-style view of your codebase, a structured CODOC language for describing intent, and a full loop of analysis, feedforward suggestions, generation, and AI-only feedback decorations.

This README is the primary reference for installation, setup, usage flow, and how the pieces fit together. For deep architectural details, see `ARCHITECTURE.md` and the referenced source files.

## 1. Prerequisites

- VS Code 1.80.0+
- Node.js 18+
- Git and a local project to analyze
- OpenCode CLI installed
- OpenAI API key (for impact analysis / feedforward)

## 2. Install OpenCode CLI
Install or upgrade [OpenCode](https://opencode.ai/docs/) following the official instructions, for example:

```bash
curl -fsSL https://opencode.ai/install | bash
```
or
```
npm install -g opencode-ai
```

Confirm it is available:

```bash
opencode --help
opencode version
```

## 3. Configure OpenCode (auth and models)
```bash
   opencode auth login
```

(Optional) You can also add a opencode.json in your project. Settings from this config are merged with and can override the global config. This is useful for configuring providers or modes specific to your project.
```
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "ask",
    "doom_loop": "ask",
    "external_directory": "ask"
  }
}
```

The CoDoc extension assumes that:
- `opencode` is on your `PATH`
- The model you intend to use for generation is available

## 4. Run OpenCode server
For local development CoDoc expects an OpenCode server endpoint. Start it from a terminal:

```bash
opencode serve -p 4096 --hostname 127.0.0.1
```

Keep this process running while you use CoDoc. If you run it on a different port or host, update your local configuration or the extension settings accordingly.

## 5. Install and build the CoDoc extension

Clone this repository and install dependencies:

```bash
cd /Users/r4yen/Desktop/Research/CoDoc/repos/CoDoc
npm install
```

Build the extension and the webview:

```bash
# Build the extension TypeScript
npm run compile

# Build the React-based webview UI
cd webview-ui
npm install
cd ..
npm run build:webview
```

You can also use the provided VS Code tasks (for example `build-all`) to run `npm: compile` and `build:webview` in sequence.

To launch the extension in an Extension Development Host:

1. Open this folder in VS Code.
2. Press `F5` to start debugging.
3. In the new window, open or create a `.codoc` file.

## 6. What this codebase does

At a high level, CoDoc provides:

- A custom text editor for `.codoc` files with a file-explorer-style layout.
- A Chevrotain-based parser that turns CODOC text into a structured `SchemaNode` tree.
- A Babel-based analysis engine that scans your actual source code and builds a dependency graph.
- A feedforward (impact analysis) loop that suggests CODOC edits based on the dependencies of what you are editing.
- An OpenCode integration that uses your CODOC structure and analysis results to drive code generation.
- A feedback decoration system that visually marks only AI-generated changes in the CODOC view (additions, removals, modifications, renames, moves, refactors) with gutter markers and hover actions.

The core types live in `src/types.ts` and are shared across these systems (`SchemaNode`, `CodebaseSnapshot`, `DependencyGraph`, `StructuralDiff`, `AIChange`, and related interfaces).

## 7. End-to-end user workflow

This section describes the typical flow from a human interaction perspective, and then points you to the implementation files.

### 7.1 Sync codebase and build the dependency graph

1. You open a `.codoc` file in the CoDoc editor.
2. You click the "Scan Codebase" button or run the `CoDoc: Scan Codebase` command.
3. The extension invokes the `AnalysisEngine` to scan your project files (for example `src/**/*.{ts,tsx,js,jsx,py,java}`) using Babel.
4. As it walks the AST, it extracts functions, components, variables, imports, exports, calls, and identifier references.
5. From this, it builds a `CodebaseSnapshot` and `DependencyGraph`, recording upstream and downstream relationships for each element.

From your perspective: after a scan completes, the CODOC view is now connected to the real codebase and can reason about dependencies.

Related files:

- `src/services/AnalysisEngine.ts` – Babel-based analysis and snapshot building
- `src/types.ts` – `CodeElement`, `FileStructure`, `CodebaseSnapshot`, `DependencyGraph`
- `src/providers/CodocEditorProvider.ts` – bridges commands from the webview to the analysis engine

### 7.2 Author CODOC structure

You describe the intended structure of your codebase using CODOC syntax in the custom editor. Example:

```text
/src                                   -> / for folder
  /components
    Register.tsx                       -> file (*.(ts,tsx,js,jsx, html, css))
      %Register                        -> component
      $handleSubmit()                  -> function
      $validateForm()
        # fetch database and auth      -> natural language commments
```

From your perspective: you think in terms of folders, files, components, and functions. CoDoc keeps indentation and structure consistent and validates against the CODOC grammar.

Related files:

- `src/parser/lexer.ts` – token definitions for directories, files, components, functions, variables, references, and notes
- `src/parser/lineParser.ts` – line-level CST parser
- `src/parser/codocParser.ts` – builds the `SchemaNode` tree and computes content hashes
- `src/parser/indentCalculator.ts` – central indentation rules

### 7.3 Feedforward: edit-driven suggestions

While you edit a `.codoc` file:

1. When you change a node that has dependencies or dependents, the editor sends an event to the extension.
2. After a short debounce (for example 2.5 seconds), the `ImpactAnalysisService` queries the dependency graph and recent generation history.
3. It calls an OpenAI model (via your OpenAI API key) to analyze the impact of your edit and suggest additional CODOC changes.
4. The webview displays these as structured suggestions (with `codocSyntax`, `reason`, `insertLine`, and `indentLevel`).

From your perspective: when you touch something that affects other parts of the system, CoDoc recommends concrete CODOC edits you may want to make elsewhere.

Related files:

- `src/services/ImpactAnalysisService.ts` – feedforward logic and OpenAI calls
- `src/types.ts` – `ImpactAnalysis`, `SuggestedChange`
- `webview-ui/src/components/CodocEditor.tsx` – renders suggestion panels and handles messages

### 7.4 Generation: calling OpenCode through the CLI

When you are satisfied with your CODOC description:

1. You click "Generate Code" or run `CoDoc: Generate with OpenCode`.
2. The extension gathers the current CODOC content and the latest `CodebaseSnapshot`.
3. It uses the OpenCode integration service to write a temporary prompt file under `/tmp`, containing your CODOC structure, analysis summaries, and any relevant context.
4. It launches `opencode generate --prompt-file ...` in a VS Code-integrated terminal.
5. OpenCode produces code changes in your real project files.
6. The extension records a concise generation summary in `.codoc/history.json` (bounded history) for later impact analysis.

From your perspective: you press one button, watch OpenCode run, and then see your project files updated accordingly.

Related files:

- `src/services/OpenCodeService.ts` or `src/services/agent/OpenCodeSDKService.ts` – wrapper around the `opencode` CLI and server endpoint
- `src/providers/CodocEditorProvider.ts` – orchestrates generation and message passing
- `src/types.ts` – `OpenCodeRequest`, `OpenCodeResponse`

### 7.5 Feedback: AI-only change decorations

After a generation finishes, CoDoc highlights only the AI-generated changes in the CODOC view. The flow is:

1. When you press "Generate", previous feedback decorations are cleared (treated as accepted).
2. The extension stores a pre-generation snapshot of the CODOC structure (`SchemaNode[]`) and `CodebaseSnapshot`.
3. OpenCode runs and modifies the codebase.
4. After a short delay, CoDoc rescans the codebase and reconstructs a new CODOC structure from the updated files.
5. The `StructuralDiffEngine` compares pre- and post-generation CODOC snapshots.
6. It classifies node-level changes into `AIChange[]`, including additions, removals, modifications, renames, moves, and refactorings.
7. The extension sends `AIChange[]` to the webview, which renders them as editor decorations.

From your perspective: you see a clear overlay of what the AI changed, without mixing in your manual edits.

Change classes and their visual treatment include:

- Add (green): new functions, components, files, directories.
- Remove (red): deleted elements, shown as strikethrough widgets.
- Modify (orange): changed content at the same path.
- Rename (blue): same content hash, different name.
- Move (purple): same content hash and name, different directory.
- Refactor (teal): extracted, inlined, split, merged, or restructured logic.

Hover affordances allow you to reject individual changes. Rejections clear the decoration and dispatch a `feedbackChangeRejected` event; full content restoration is a planned enhancement.

Related files:

- `src/services/StructuralDiffEngine.ts` – structural diff and `AIChange` classification
- `src/services/AnalysisEngine.ts` – provides the structural snapshots used for comparison
- `src/providers/CodocEditorProvider.ts` – orchestrates pre/post snapshots and sends `AIChange[]` to the webview
- `webview-ui/src/lib/editor/feedbackDecorationExtension.ts` – CodeMirror decorations for AI feedback
- `webview-ui/src/components/CodocEditor.tsx` – routes messages and hooks the extension into the view

### 7.6 Gutters, monitors, and editor behavior

The webview editor is built on CodeMirror and uses custom extensions to represent CODOC semantics:

- Feedback decorations: colored backgrounds, borders, gutter markers, hover buttons, and deletion widgets driven by `AIChange` objects.
- Activity and impact gutters: visual cues for where recent activity or suggestions are located.
- Dependency and file-structure extensions: highlighting of related nodes and collapsible structure.
- Schema folding: expand and collapse directories, files, and logical sections.

From your perspective: the editor behaves like a structured file explorer plus outline view, with gutters that surface analysis, suggestions, and AI feedback without leaving the CODOC context.

Related files:

- `webview-ui/src/lib/editor/activityGutterExtension.ts`
- `webview-ui/src/lib/editor/dependencyHighlightExtension.ts`
- `webview-ui/src/lib/editor/fileStructureExtension.ts`
- `webview-ui/src/lib/editor/schemaFoldingExtension.ts`
- `webview-ui/src/lib/editor/feedforwardService.ts`
- `webview-ui/src/lib/editor/feedbackDecorationExtension.ts`

## 8. Configuration and settings

In VS Code settings you can configure OpenAI and impact analysis behavior, for example:

```json
{
  "codoc.openaiApiKey": "sk-..."
}
```

You can also adjust any future settings that control which files are analyzed, how generations are scoped, or what host/port the OpenCode server uses, depending on how you wire the configuration in `extension.ts` and the services under `src/services/`.

## 9. Development workflow

Key paths and scripts:

- Core extension entry: `src/extension.ts`
- Custom editor provider: `src/providers/CodocEditorProvider.ts`
- Services: `src/services/*`
- Parser: `src/parser/*`
- Webview UI: `webview-ui/src/*`

Build and watch during development:

```bash
npm run compile       # Build extension
npm run watch         # TypeScript watch mode for extension
npm run build:webview # Build React webview
```

To debug, use `F5` in VS Code to launch an Extension Development Host and work against a test project and `.codoc` file.

## 10. CODOC syntax reference

| Syntax     | Element    | Example          |
|-----------|------------|------------------|
| `/name`   | Directory  | `/src`           |
| `file.ext`| File       | `Register.tsx`   |
| `%Name`   | Component  | `%Register`      |
| `$name()` | Function   | `$handleSubmit()`|
| `varName` | Variable   | `emailInput`     |
| `@name`   | Reference  | `@useAuth`       |
| `# text`  | Note       | `# Auth logic`   |

Indentation: 2 spaces per level.

## 11. License

MIT
