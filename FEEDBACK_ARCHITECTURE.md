# Feedback Decoration Architecture

## Overview

The feedback decoration system shows **AI-generated changes only**, not human edits. It provides comprehensive change classification including additions, removals, modifications, renames, moves, and refactorings.

## Key Principles

1. **AI Changes Only**: Feedback decorations display only what the AI modified, not user edits
2. **Clear on Generate**: When user presses "Generate", previous decorations clear (assumes acceptance)
3. **Persist Until Action**: Decorations stay visible until next generation or explicit rejection
4. **CoDoc-Native Display**: Changes shown in CoDoc syntax, no extra UI indicators

## Architecture Flow

### Generation Workflow

```
1. User presses "Generate" button
   ↓
2. Clear previous feedback decorations
   ↓
3. Store pre-generation CoDoc snapshot (AnalysisEngine.scanCodebase() + constructCodoc())
   ↓
4. Execute OpenCode generation
   ↓
5. Wait for file system to settle (1s)
   ↓
6. Rescan codebase and reconstruct new CoDoc
   ↓
7. Compare pre-generation CoDoc with post-generation CoDoc (StructuralDiffEngine.compare())
   ↓
8. Classify changes into AIChange[] (StructuralDiffEngine.convertToAIChanges())
   ↓
9. Send AIChange[] to webview
   ↓
10. Display feedback decorations in editor
```

### Change Classification

The system detects and classifies:

#### 1. **Add** (Green)
- New functions, components, files, directories
- Detection: Node exists in post-generation but not pre-generation
- Decoration: Green background, green gutter marker
- Action: Reject button removes the addition

#### 2. **Remove** (Red)
- Deleted functions, components, files
- Detection: Node exists in pre-generation but not post-generation
- Decoration: Red strikethrough widget showing deleted content
- Action: Reject button restores the content

#### 3. **Modify** (Orange)
- Changed function/component content
- Detection: Same path, different content hash
- Decoration: Orange left border, orange gutter marker
- Action: Reject button reverts to original

#### 4. **Rename** (Blue)
- Name changed, same location and content
- Detection: Same content hash, same directory, different name
- Decoration: Blue left border, blue gutter marker
- Action: Reject button reverts to original name

#### 5. **Move** (Purple)
- Location changed, same name and content
- Detection: Same content hash, same name, different directory
- Decoration: Purple left border, purple gutter marker
- Action: Reject button reverts to original location

#### 6. **Refactor** (Teal)
- Extract, inline, split, merge operations
- Detection: Heuristic patterns (e.g., new small function + modified caller)
- Decoration: Teal left border, teal gutter marker
- Types: `extract`, `inline`, `split`, `merge`, `restructure`
- Action: Reject button reverts refactoring

## File Structure

### Backend (TypeScript - Extension)

```
src/
├── types.ts                       # AIChange interface definition
├── services/
│   ├── AnalysisEngine.ts         # Scans codebase, builds CoDoc
│   └── StructuralDiffEngine.ts   # Compares CoDoc snapshots, classifies changes
└── providers/
    └── CodocEditorProvider.ts    # Orchestrates generation workflow
```

### Frontend (TypeScript - Webview)

```
webview-ui/src/
├── components/
│   └── CodocEditor.tsx                        # Message handling
└── lib/editor/
    └── feedbackDecorationExtension.ts         # CodeMirror decorations
```

## Key Components

### StructuralDiffEngine

**Purpose**: Compare two CoDoc structures and classify changes

**Key Methods**:
- `compare(oldNodes, newNodes)`: Structural diff (add/remove/modify/rename)
- `convertToAIChanges(diff)`: Convert to AIChange[] with full classification
- `detectRefactorings(diff)`: Heuristic pattern matching for refactors

**Refactoring Detection Patterns**:
- **Extract**: New function + modified caller in same file
- **Inline**: Removed function + modified caller in same file
- **Split**: One removed function → multiple added functions with similar names
- **Merge**: Multiple removed functions → one new function

### CodocEditorProvider

**Purpose**: Orchestrate generation and feedback workflow

**Key State**:
```typescript
private preGenerationCoDoc: SchemaNode[] = [];
private preGenerationSnapshot: CodebaseSnapshot | null = null;
```

**Key Flow**:
1. `generateCode()`: Store snapshot before generation
2. After generation: Rescan codebase
3. Compare snapshots using StructuralDiffEngine
4. Send AIChange[] to webview

### feedbackDecorationExtension

**Purpose**: Render feedback decorations in CodeMirror editor

**Key Features**:
- Line decorations with hover buttons
- Gutter markers (colored bars)
- Deletion widgets for removed content
- Rejection handlers

**State Management**:
- `setFeedbackDecorations`: Replace all decorations
- `clearFeedbackDecorations`: Clear all decorations
- `rejectFeedbackChange`: Remove specific decoration

## Data Flow

```
Backend:
AnalysisEngine.scanCodebase()
  ↓
SchemaNode[] (CoDoc structure)
  ↓
StructuralDiffEngine.compare(pre, post)
  ↓
StructuralDiff { added, removed, modified, renamed }
  ↓
StructuralDiffEngine.convertToAIChanges(diff)
  ↓
AIChange[] { type, element, lineNumber, content, ... }
  ↓
Webview Message: { type: 'showFeedbackDecorations', changes: AIChange[] }

Frontend:
CodocEditor receives message
  ↓
showFeedbackDecorationsInView(view, changes)
  ↓
feedbackDecorationPlugin.update()
  ↓
buildFeedbackDecorations(changes)
  ↓
Render decorations in CodeMirror
```

## Visual Design

### Color Scheme

| Change Type | Background | Border | Gutter | Dark Mode |
|------------|------------|--------|--------|-----------|
| Add | Green (15%) | - | #22bb22 | Green (20%) |
| Modify | Orange (15%) | Orange (60%) | #ffa500 | Orange (20%) |
| Rename | Blue (15%) | Blue (60%) | #3a96dd | Blue (20%) |
| Move | Purple (15%) | Purple (60%) | #9370db | Purple (20%) |
| Refactor | Teal (15%) | Teal (60%) | #009688 | Teal (20%) |
| Remove | Red (5%) | Red (20%) | #ee4433 | Red (8%) |

### Hover Actions

- **Add**: ✕ button ("Remove this addition")
- **Modify**: ↶ button ("Revert this change")
- **Rename**: ↶ button ("Revert rename (was: OriginalName)")
- **Move**: ↶ button ("Revert move (from: OriginalPath)")
- **Refactor**: ↶ button ("Revert refactor (extract/inline/...)")
- **Remove**: ✕ button ("Restore this content") with strikethrough preview

## User Experience

### Normal Workflow

1. User edits CoDoc (e.g., adds `$handleSubmit()`)
2. User presses "Generate"
3. AI generates code
4. CoDoc auto-updates with new structure
5. **Green highlights** show additions (new functions)
6. **Orange borders** show modifications (changed functions)
7. **Blue borders** show renames
8. **Purple borders** show moves
9. **Teal borders** show refactorings
10. **Red strikethrough** shows deletions
11. User reviews changes, can reject specific ones
12. User continues editing, presses "Generate" again
13. Previous decorations clear, new ones appear

### Rejection Workflow

1. User hovers over decorated line
2. Reject button appears
3. User clicks reject
4. Decoration disappears
5. Custom event dispatched: `feedbackChangeRejected`
6. Parent component can handle content restoration (future enhancement)

## Implementation Details

### AIChange Interface

```typescript
interface AIChange {
  id: string;
  type: 'add' | 'remove' | 'modify' | 'rename' | 'move' | 'refactor';
  
  element: {
    type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
    name: string;
    path: string;
  };
  
  lineNumber: number;
  indentLevel: number;
  
  content?: string;
  originalContent?: string;
  
  fromPath?: string;  // For moves
  toPath?: string;
  fromName?: string;  // For renames
  toName?: string;
  
  refactorType?: 'extract' | 'inline' | 'split' | 'merge' | 'restructure';
  
  confidence: number;
  timestamp: number;
}
```

### Change Priority

When multiple changes affect the same line:

```
Priority (highest to lowest):
1. remove (show deletion widget)
2. refactor (show refactoring indicator)
3. move (show move indicator)
4. rename (show rename indicator)
5. modify (show modification)
6. add (show addition)
```

## Future Enhancements

1. **Content Restoration**: Implement full revert functionality for rejected changes
2. **Batch Operations**: Accept/reject all changes at once
3. **Change History**: Track rejected changes for undo/redo
4. **Smart Grouping**: Group related changes (e.g., rename + all references)
5. **AI Explanations**: Add tooltips explaining why AI made each change
6. **Confidence Thresholds**: Hide low-confidence refactoring detections
7. **Diff View**: Show side-by-side before/after for modifications
8. **Interactive Merge**: Allow user to selectively accept parts of a change

## Testing Scenarios

### Scenario 1: Simple Addition
- User adds `$newFunction()` to CoDoc
- Presses Generate
- AI creates the function
- CoDoc shows `$newFunction()` with green highlight

### Scenario 2: Function Rename
- Codebase has `function oldName()`
- AI renames to `function newName()`
- CoDoc shows `$newName()` with blue border
- Hover shows "Revert rename (was: oldName)"

### Scenario 3: File Move
- Codebase has `src/utils.ts`
- AI moves to `src/helpers/utils.ts`
- CoDoc shows `utils.ts` under `/helpers` with purple border
- Hover shows "Revert move (from: src/utils.ts)"

### Scenario 4: Extract Refactor
- Codebase has one large function
- AI extracts helper functions
- CoDoc shows new functions with teal border
- Hover shows "Revert refactor (extract)"

### Scenario 5: Multiple Generations
- User generates code (shows decorations)
- User continues editing CoDoc
- User generates again
- Previous decorations clear, new ones appear

## Debugging

### Enable Verbose Logging

In `feedbackDecorationExtension.ts`:
```typescript
console.log('Finding element:', change);
console.log('Rejecting change:', changeId);
```

In `StructuralDiffEngine.ts`:
```typescript
console.log('Diff results:', { 
  added: diff.added.length, 
  removed: diff.removed.length,
  modified: diff.modified.length,
  renamed: diff.renamed.length 
});
```

### Common Issues

1. **Decorations not showing**: Check if AIChange[] has valid lineNumber
2. **Wrong classification**: Verify content hash calculation
3. **Decorations persist**: Ensure clearFeedbackDecorations called on generate
4. **Multiple decorations on same line**: Check priority in buildFeedbackDecorations

## Performance Considerations

- **Snapshot Storage**: Pre-generation snapshot stored in memory, cleared after comparison
- **Diff Computation**: O(n) where n = number of nodes in CoDoc
- **Refactoring Detection**: Heuristic patterns, O(n²) worst case for split detection
- **Decoration Rendering**: CodeMirror efficiently handles decoration updates
- **Large Codebases**: Consider limiting diff to recently modified files

## Related Files

- `FEEDFORWARD_IMPLEMENTATION.md`: Feedforward suggestion system
- `ARCHITECTURE.md`: Overall system architecture
- `PROJECT_SUMMARY.md`: Project overview
