# CoDoc Extension

Lightweight VSCode extension for authoring CODOC structures with OpenCode integration and dependency-aware code generation.

## Features

- 🎯 **File-explorer-style code editor** for CODOC syntax  
- 🔍 **Dependency tracking** with Babel-based analysis  
- 🤖 **OpenCode CLI integration** for code generation  
- 📊 **Visual hierarchy** with opacity-based focus  
- 🔄 **Content-hash-based rename detection** using SHA-256  
- 💡 **Impact analysis** using OpenAI API for edit-driven suggestions  

## Prerequisites

- VS Code 1.80.0+
- Node.js 18+
- OpenCode CLI installed and authenticated (`opencode login`)
- OpenAI API key (for impact analysis)

## Installation

```bash
# Install dependencies
npm install

# Build extension
npm run compile

# Build webview
cd webview-ui && npm install && cd ..
```

## Usage

### 1. Open CoDoc Editor

Create or open a `.codoc` file - it will automatically open in the custom CoDoc editor.

### 2. Scan Codebase

Click "Scan Codebase" button or run command:
```
CoDoc: Scan Codebase
```

This analyzes your project using Babel traverse to extract:
- Functions, components, variables
- Import/export relationships
- Function calls and references
- Complete dependency graph

### 3. Author Code Structure

Use CODOC syntax:

```
/src
  /components
    Register.tsx
      %Register
        $handleSubmit()
        $validateForm()
        emailInput
        passwordInput
        # User authentication logic
```

### 4. Generate Code

Click "Generate Code" or run command:
```
CoDoc: Generate with OpenCode
```

Enter your prompt and OpenCode CLI generates code based on the CODOC structure.

### 5. Impact Analysis (Automatic)

When you edit a node with dependencies:
- Automatically debounced 2.5s after edit
- Calls OpenAI API to analyze impact
- Shows inline suggestions for CODOC changes

## Configuration

Add to VSCode settings:

```json
{
  "codoc.openaiApiKey": "sk-...",
  "codoc.impactAnalysis.enabled": true,
  "codoc.impactAnalysis.debounceMs": 2500
}
```

## CODOC Syntax Reference

| Syntax | Element | Example |
|--------|---------|---------|
| `/name` | Directory | `/src` |
| `file.ext` | File | `Register.tsx` |
| `%Name` | Component | `%Register` |
| `$name()` | Function | `$handleSubmit()` |
| `varName` | Variable | `emailInput` |
| `@name` | Reference | `@useAuth` |
| `# text` | Note | `# Auth logic` |

**Indentation**: 2 spaces per level

## Architecture Highlights

### Dependency Extraction
Uses `@babel/parser` + `@babel/traverse` to analyze:
- ImportDeclaration → imports[]
- FunctionDeclaration → functions + calls[]
- CallExpression → references[]

### Content Hashing
SHA-256 hash of normalized code enables:
- Rename detection (same hash, different path)
- Structural diff (compare old vs new)

### Impact Analysis
Debounced OpenAI API calls analyze:
- Edited node dependencies
- Last generation summary
- Suggests CODOC structural changes

## Development

### Project Structure

```
src/
  parser/           # Chevrotain-based CODOC parser
  services/         # Core services (analysis, diff, OpenCode, impact)
  providers/        # VSCode providers
  extension.ts      # Entry point

webview-ui/
  src/
    components/     # React components
    index.tsx       # Webview entry
```

### Build Commands

```bash
npm run compile       # Build extension
npm run watch         # Watch mode
npm run build:webview # Build React webview
```

### Debug

Press F5 in VSCode to launch Extension Development Host.

## Documentation

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation.

## License

MIT
