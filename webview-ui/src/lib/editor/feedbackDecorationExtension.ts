import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  GutterMarker,
  gutter,
  MouseSelectionStyle
} from "@codemirror/view";
import {
  EditorState,
  StateField,
  StateEffect,
  RangeSetBuilder,
  RangeSet,
  Prec
} from "@codemirror/state";
// import { CodocMergeChange } from "../../lib/services/codocMergeService";

/**
 * AI-generated change for feedback decorations
 * Only represents changes made by AI, not human edits
 * Matches backend AIChange interface
 */
export interface CodocMergeChange {
  id: string;
  type: 'add' | 'remove' | 'modify' | 'rename' | 'move' | 'refactor';
  
  element: {
    type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
    name: string;
    path: string;
  };
  
  // Location in CoDoc
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
  
  // For refactoring
  refactorType?: 'extract' | 'inline' | 'split' | 'merge' | 'restructure';
  
  // Metadata
  confidence?: number;
  timestamp?: number;
}

// State effect to set feedback decorations (REPLACES all changes - used on generate)
export const setFeedbackDecorations = StateEffect.define<CodocMergeChange[]>();

// State effect to clear feedback decorations (used when generate button is pressed)
export const clearFeedbackDecorations = StateEffect.define<void>();

// State effect to reject a specific change
export const rejectFeedbackChange = StateEffect.define<{changeId: string}>();

// State field to store the feedback changes
const feedbackChangesField = StateField.define<CodocMergeChange[]>({
  create() {
    return [];
  },
  update(changes, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFeedbackDecorations)) {
        // REPLACE all changes (used after generation completes)
        return effect.value.map((change, index) => ({
          ...change,
          id: change.id || `change-${Date.now()}-${index}`
        }));
      }
      if (effect.is(clearFeedbackDecorations)) {
        return [];
      }
      if (effect.is(rejectFeedbackChange)) {
        console.log('rejecting change', changes.find(change => change.id === effect.value.changeId));
        return changes.filter(change => change.id !== effect.value.changeId);
      }
    }
    return changes;
  }
});

// Decoration types
const addedLine = Decoration.line({
  class: "cm-feedbackAddedLine",
  attributes: { "data-feedback-type": "added" }
});

const modifiedLine = Decoration.line({
  class: "cm-feedbackModifiedLine", 
  attributes: { "data-feedback-type": "modified" }
});

const renamedLine = Decoration.line({
  class: "cm-feedbackRenamedLine",
  attributes: { "data-feedback-type": "renamed" }
});

const movedLine = Decoration.line({
  class: "cm-feedbackMovedLine",
  attributes: { "data-feedback-type": "moved" }
});

const refactoredLine = Decoration.line({
  class: "cm-feedbackRefactoredLine",
  attributes: { "data-feedback-type": "refactored" }
});

// Note: removedLine decoration is handled by widget instead of line decoration
// const removedLine = Decoration.line({
//   class: "cm-feedbackRemovedLine", 
//   attributes: { "data-feedback-type": "removed" }
// });

// Gutter markers
const addedGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackAddedGutter";
}();

const modifiedGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackModifiedGutter";
}();

const removedGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackRemovedGutter";
}();

const renamedGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackRenamedGutter";
}();

const movedGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackMovedGutter";
}();

const refactoredGutterMarker = new class extends GutterMarker {
  elementClass = "cm-feedbackRefactoredGutter";
}();

// Widget for deleted content (compact, indented, gray strikethrough)
class FeedbackDeletionWidget extends WidgetType {
  constructor(
    private change: CodocMergeChange,
    private view: EditorView
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-feedbackDeletedChunk";

    const indentLevel = this.change.indentLevel || 0;
    const contentText = (this.change.content || '').split('\n')[0] || this.change.element.name;
    // Calculate indentation (2 spaces per indent level)
    const indentSpaces = '  '.repeat(indentLevel);

    // Add reject button (only visible on hover)
    const buttonContainer = dom.appendChild(document.createElement("span"));
    buttonContainer.className = "cm-feedbackButtonContainer cm-feedbackDeletedButton";

    const rejectButton = buttonContainer.appendChild(document.createElement("button"));
    rejectButton.className = "cm-feedbackRejectButton";
    rejectButton.textContent = "✕";
    rejectButton.title = "Restore this content";
    rejectButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const changeId = this.change.id || 'unknown';
      this.view.dispatch({
        effects: rejectFeedbackChange.of({ changeId })
      });
      const detailChange = {
        ...this.change,
        element: { ...this.change.element }
      };
      window.dispatchEvent(new CustomEvent('feedbackChangeRejected', {
        detail: { change: detailChange }
      }));
    };

    if (contentText.trim()) {
      const contentSpan = dom.appendChild(document.createElement("span"));
      contentSpan.className = "cm-feedbackDeletedText";

      // Apply indentation and show content inline with strikethrough
      contentSpan.textContent = indentSpaces + contentText.trim();
    }

    return dom;
  }

  get estimatedHeight() {
    // Compact single-line widget
    return 18;
  }
}

// Widget for hover buttons on added/modified lines
class FeedbackHoverButtonWidget extends WidgetType {
  constructor(
    private change: CodocMergeChange,
    private view: EditorView
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-feedbackHoverButton";
    
    const button = dom.appendChild(document.createElement("button"));
    button.className = "cm-feedbackRejectButton";
    
    // Set button text and title based on change type
    switch (this.change.type) {
      case 'add':
        button.textContent = "✕";
        button.title = "Remove this addition";
        break;
      case 'modify':
        button.textContent = "↶";
        button.title = "Revert this change";
        break;
      case 'rename':
        button.textContent = "↶";
        button.title = `Revert rename (was: ${this.change.fromName || this.change.originalContent || 'unknown'})`;
        break;
      case 'move':
        button.textContent = "↶";
        button.title = `Revert move (from: ${this.change.fromPath || this.change.originalContent || 'unknown'})`;
        break;
      case 'refactor':
        button.textContent = "↶";
        button.title = `Revert refactor (${this.change.refactorType || this.change.originalContent || 'refactor'})`;
        break;
    }
    
    button.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const changeId = this.change.id || 'unknown';
      this.view.dispatch({
        effects: rejectFeedbackChange.of({ changeId })
      });
      // Dispatch custom event for parent component to handle content restoration
      const detailChange = {
        ...this.change,
        element: { ...this.change.element }
      };
      window.dispatchEvent(new CustomEvent('feedbackChangeRejected', {
        detail: { change: detailChange }
      }));
    };
    
    return dom;
  }

  get estimatedHeight() {
    return 0; // Inline widget
  }
}

// Function to find line number for a given element in merged content
function findElementLineNumber(doc: EditorState['doc'], change: CodocMergeChange): number {
  const lines = doc.toString().split('\n');
  
  // console.log('finding', change);
  
  if (change.lineNumber && change.lineNumber > 0 && change.lineNumber <= lines.length) {
    return change.lineNumber;
  }
  
  const element = change.element;
  
  const searchPatterns = [];
  
  switch (element.type) {
    case 'component':
      searchPatterns.push(`%${element.name}`);
      break;
    case 'function':
      searchPatterns.push(`$${element.name}()`);
      break;
    case 'file':
      searchPatterns.push(element.name);
      if (element.path) {
        const pathParts = element.path.split('/');
        const filename = pathParts[pathParts.length - 1];
        if (filename !== element.name) {
          searchPatterns.push(filename);
        }
      }
      break;
    case 'directory':
      searchPatterns.push(`/${element.name}`);
      if (element.path) {
        const dirName = element.path.split('/').pop();
        if (dirName && dirName !== element.name) {
          searchPatterns.push(`/${dirName}`);
        }
      }
      break;
    case 'reference':
      searchPatterns.push(`@${element.name}`);
      if (element.path) {
        searchPatterns.push(`@${element.path}`);
      }
      break;
    default:
      searchPatterns.push(element.name);
  }
  
  
  // If we have indentLevel information, use it to find the correct position
  if (change.indentLevel !== undefined) {
    
    // Find the line with correct indentation and matching pattern
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineIndent = line.match(/^(\s*)/)?.[1] || '';
      const lineTrimmed = line.trim();
      
      // Check if indentation matches (allowing some flexibility)
      const lineIndentLevel = Math.floor(lineIndent.length / 2);
      
      if (lineIndentLevel === change.indentLevel) {
        // Check if any search pattern matches exactly
        for (const pattern of searchPatterns) {
          if (lineTrimmed === pattern) {
            return i + 1; // Convert to 1-based line number
          }
        }
      }
    }
    
    // Try again with partial matching for the same indent level
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineIndent = line.match(/^(\s*)/)?.[1] || '';
      const lineTrimmed = line.trim();
      
      const lineIndentLevel = Math.floor(lineIndent.length / 2);
      
      if (lineIndentLevel === change.indentLevel) {
        // Check if any search pattern is contained in the line
        for (const pattern of searchPatterns) {
          if (lineTrimmed.includes(pattern)) {
            return i + 1; // Convert to 1-based line number
          }
        }
      }
    }
  }
  

  // Fallback: search without indentation constraint
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pattern of searchPatterns) {
      if (line === pattern) {
        return i + 1; // Convert to 1-based line number
      }
    }
  }
  
  // Last resort: partial matching without indent
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pattern of searchPatterns) {
      if (line.includes(pattern)) {
        return i + 1; // Convert to 1-based line number
      }
    }
  }
  
  return -1; // Not found
}

// Function to build decorations from feedback changes
function buildFeedbackDecorations(view: EditorView): { deco: DecorationSet, gutter: RangeSet<GutterMarker> } {
  const changes = view.state.field(feedbackChangesField);
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  const gutterBuilder = new RangeSetBuilder<GutterMarker>();
  
  // Group changes by line to avoid conflicts
  const changesByLine = new Map<number, CodocMergeChange[]>();
  
  for (const change of changes) {
    const lineNumber = findElementLineNumber(doc, change);

    if (lineNumber > 0) {
      if (!changesByLine.has(lineNumber)) {
        changesByLine.set(lineNumber, []);
      }
      changesByLine.get(lineNumber)!.push(change);
    } else {
      // console.warn(`[FeedbackDecorations] Could not find line for change:`, change);
    }
  }
  
  // Sort lines and process each line
  const sortedLines = Array.from(changesByLine.keys()).sort((a, b) => a - b);
  
  for (const lineNumber of sortedLines) {
    const lineChanges = changesByLine.get(lineNumber)!;
    let line;
    
    if (lineNumber <= doc.lines) {
      line = doc.line(lineNumber);
    } else {
      // If line number is beyond document, add at the end
      line = doc.line(doc.lines);
    }
    
    // Prioritize changes: remove > refactor > move > rename > modify > add
    const sortedLineChanges = lineChanges.sort((a, b) => {
      const priority: { [key: string]: number } = { 
        'remove': 6, 
        'refactor': 5,
        'move': 4, 
        'rename': 3,
        'modify': 2, 
        'add': 1 
      };
      return (priority[b.type] || 0) - (priority[a.type] || 0);
    });
    
    // Only process the highest priority change for this line
    const primaryChange = sortedLineChanges[0];
    
    switch (primaryChange.type) {
      case 'add':
        // Add line decoration and gutter marker
        builder.add(line.from, line.from, addedLine);
        gutterBuilder.add(line.from, line.from, addedGutterMarker);
        
        // Add hover button widget at the end of the line
        const addHoverWidget = Decoration.widget({
          widget: new FeedbackHoverButtonWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.to, line.to, addHoverWidget);
        break;
        
      case 'modify':
        // Add line decoration and gutter marker
        builder.add(line.from, line.from, modifiedLine);
        gutterBuilder.add(line.from, line.from, modifiedGutterMarker);
        
        // Add hover button widget at the end of the line
        const modifyHoverWidget = Decoration.widget({
          widget: new FeedbackHoverButtonWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.to, line.to, modifyHoverWidget);
        break;
      
      case 'rename':
        // Add renamed line decoration and gutter marker
        builder.add(line.from, line.from, renamedLine);
        gutterBuilder.add(line.from, line.from, renamedGutterMarker);
        
        // Add hover button widget
        const renameHoverWidget = Decoration.widget({
          widget: new FeedbackHoverButtonWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.to, line.to, renameHoverWidget);
        break;
      
      case 'move':
        // Add moved line decoration and gutter marker
        builder.add(line.from, line.from, movedLine);
        gutterBuilder.add(line.from, line.from, movedGutterMarker);
        
        // Add hover button widget
        const moveHoverWidget = Decoration.widget({
          widget: new FeedbackHoverButtonWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.to, line.to, moveHoverWidget);
        break;
      
      case 'refactor':
        // Add refactored line decoration and gutter marker
        builder.add(line.from, line.from, refactoredLine);
        gutterBuilder.add(line.from, line.from, refactoredGutterMarker);
        
        // Add hover button widget
        const refactorHoverWidget = Decoration.widget({
          widget: new FeedbackHoverButtonWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.to, line.to, refactorHoverWidget);
        break;
        
      case 'remove':
        // For removals, we create a widget to show the deleted content
        const deletionWidget = Decoration.widget({
          widget: new FeedbackDeletionWidget(primaryChange, view),
          side: 1
        });
        builder.add(line.from, line.from, deletionWidget);
        gutterBuilder.add(line.from, line.from, removedGutterMarker);
        break;
    }
  }
  
  const decorations = builder.finish();
  const gutterMarkers = gutterBuilder.finish();
  
  return {
    deco: decorations,
    gutter: gutterMarkers
  };
}

// View plugin to manage decorations with persistence
export const feedbackDecorationPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    gutter: RangeSet<GutterMarker>;
    
    constructor(view: EditorView) {
      const result = buildFeedbackDecorations(view);
      this.deco = result.deco;
      this.gutter = result.gutter;
    }
    
    update(update: ViewUpdate) {
      const changesUpdated = update.transactions.some(tr =>
        tr.effects.some(e => e.is(setFeedbackDecorations) || e.is(clearFeedbackDecorations))
      );
      
      if (changesUpdated) {
        // Rebuild decorations when changes are updated
        const result = buildFeedbackDecorations(update.view);
        this.deco = result.deco;
        this.gutter = result.gutter;
      } else if (update.docChanged) {
        // Map decorations through document changes to maintain positions
        this.deco = this.deco.map(update.changes);
        this.gutter = this.gutter.map(update.changes);
      }
    }
  },
  {
    decorations: (plugin) => plugin.deco
  }
);

// Gutter extension for feedback changes
export const feedbackGutter = Prec.low(gutter({
  class: "cm-feedbackGutter",
  markers: (view) => view.plugin(feedbackDecorationPlugin)?.gutter || RangeSet.empty
}));

// Theme for feedback decorations
export const feedbackTheme = EditorView.baseTheme({
  // Added line styling (green)
  ".cm-feedbackAddedLine": {
    backgroundColor: "rgba(34, 187, 34, 0.15)",
    paddingLeft: "4px",
    position: "relative"
  },
  
  // Modified line styling (orange)
  ".cm-feedbackModifiedLine": {
    backgroundColor: "rgba(255, 165, 0, 0.15)",
    borderLeft: "3px solid rgba(255, 165, 0, 0.6)", 
    paddingLeft: "4px",
    position: "relative"
  },
  
  // Renamed line styling (blue)
  ".cm-feedbackRenamedLine": {
    backgroundColor: "rgba(58, 150, 221, 0.15)",
    borderLeft: "3px solid rgba(58, 150, 221, 0.6)",
    paddingLeft: "4px",
    position: "relative"
  },
  
  // Moved line styling (purple)
  ".cm-feedbackMovedLine": {
    backgroundColor: "rgba(147, 112, 219, 0.15)",
    borderLeft: "3px solid rgba(147, 112, 219, 0.6)",
    paddingLeft: "4px",
    position: "relative"
  },
  
  // Refactored line styling (teal)
  ".cm-feedbackRefactoredLine": {
    backgroundColor: "rgba(0, 150, 136, 0.15)",
    borderLeft: "3px solid rgba(0, 150, 136, 0.6)",
    paddingLeft: "4px",
    position: "relative"
  },
  
  // Removed line styling (no background, handled by widget)
  ".cm-feedbackRemovedLine": {
    // No styling - widget handles display
  },
  
  // Deleted content widget (compact, inline)
  ".cm-feedbackDeletedChunk": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingLeft: "4px",
    borderLeft: "3px solid rgba(238, 68, 51, 0.6)",
    margin: "2px 0",
    whiteSpace: "pre",
  },
  
  ".cm-feedbackDeletedText": {
    textDecoration: "line-through",
    color: "#888",
    fontSize: "0.85em",
    fontFamily: "monospace",
    opacity: 0.7,
  },
  
  ".cm-feedbackDeletedButton": {
    opacity: "0",
    transition: "opacity 0.2s ease",
  },
  
  ".cm-feedbackDeletedChunk:hover .cm-feedbackDeletedButton": {
    opacity: "1",
  },
  
  // Gutter markers
  ".cm-feedbackGutter": {
    width: "4px",
    paddingLeft: "1px"
  },
  
  ".cm-feedbackAddedGutter": {
    background: "#22bb22",
    borderRadius: "2px"
  },
  
  ".cm-feedbackModifiedGutter": {
    background: "#ffa500", 
    borderRadius: "2px"
  },
  
  ".cm-feedbackRenamedGutter": {
    background: "#3a96dd",
    borderRadius: "2px"
  },
  
  ".cm-feedbackMovedGutter": {
    background: "#9370db",
    borderRadius: "2px"
  },
  
  ".cm-feedbackRefactoredGutter": {
    background: "#009688",
    borderRadius: "2px"
  },
  
  ".cm-feedbackRemovedGutter": {
    background: "#ee4433",
    borderRadius: "2px"
  },
  
  // Hover button styling
  ".cm-feedbackHoverButton": {
    display: "inline-block",
    marginLeft: "8px",
    opacity: "0",
    transition: "opacity 0.2s ease",
    pointerEvents: "none",
    position: "relative",
    zIndex: "10"
  },
  
  ".cm-line:hover .cm-feedbackHoverButton": {
    opacity: "1",
    pointerEvents: "auto"
  },
  
  ".cm-feedbackAddedLine:hover .cm-feedbackHoverButton, .cm-feedbackModifiedLine:hover .cm-feedbackHoverButton, .cm-feedbackRenamedLine:hover .cm-feedbackHoverButton, .cm-feedbackMovedLine:hover .cm-feedbackHoverButton, .cm-feedbackRefactoredLine:hover .cm-feedbackHoverButton": {
    opacity: "1",
    pointerEvents: "auto"
  },
  
  ".cm-feedbackRejectButton": {
    background: "rgba(238, 68, 51, 0.8)",
    color: "white",
    border: "none",
    borderRadius: "3px",
    padding: "2px 6px",
    fontSize: "12px",
    cursor: "pointer",
    fontWeight: "bold",
    transition: "background-color 0.2s ease"
  },
  
  ".cm-feedbackRejectButton:hover": {
    background: "rgba(238, 68, 51, 1)"
  },
  
  ".cm-feedbackButtonContainer": {
    position: "absolute",
    right: "8px",
    top: "4px",
    zIndex: "10"
  },
  
  
  // Dark theme variants
  "&dark .cm-feedbackAddedLine": {
    backgroundColor: "rgba(34, 187, 34, 0.2)",
  },
  
  "&dark .cm-feedbackModifiedLine": {
    backgroundColor: "rgba(255, 165, 0, 0.2)",
    borderLeft: "3px solid rgba(255, 165, 0, 0.8)"
  },
  
  "&dark .cm-feedbackRenamedLine": {
    backgroundColor: "rgba(58, 150, 221, 0.2)",
    borderLeft: "3px solid rgba(58, 150, 221, 0.8)"
  },
  
  "&dark .cm-feedbackMovedLine": {
    backgroundColor: "rgba(147, 112, 219, 0.2)",
    borderLeft: "3px solid rgba(147, 112, 219, 0.8)"
  },
  
  "&dark .cm-feedbackRefactoredLine": {
    backgroundColor: "rgba(0, 150, 136, 0.2)",
    borderLeft: "3px solid rgba(0, 150, 136, 0.8)"
  },
  
  "&dark .cm-feedbackRemovedLine": {
    // No styling - widget handles display
  },
  
  "&dark .cm-feedbackDeletedChunk": {
    borderLeft: "3px solid rgba(255, 102, 85, 0.8)",
  },
  
  "&dark .cm-feedbackDeletedText": {
    color: "#999",
    opacity: 0.6,
  },
  
  "&dark .cm-feedbackAddedGutter": {
    background: "#44dd44"
  },
  
  "&dark .cm-feedbackModifiedGutter": {
    background: "#ffbb33"
  },
  
  "&dark .cm-feedbackRenamedGutter": {
    background: "#5ab4f5"
  },
  
  "&dark .cm-feedbackMovedGutter": {
    background: "#b399e3"
  },
  
  "&dark .cm-feedbackRefactoredGutter": {
    background: "#00bfa5"
  },
  
  "&dark .cm-feedbackRemovedGutter": {
    background: "#ff6655"
  },
  
  "&dark .cm-feedbackRejectButton": {
    background: "rgba(255, 102, 85, 0.8)"
  },
  
  "&dark .cm-feedbackRejectButton:hover": {
    background: "rgba(255, 102, 85, 1)"
  }
});

// Main extension that combines all parts
export function feedbackDecorationExtension() {
  return [
    feedbackChangesField,
    feedbackDecorationPlugin,
    feedbackGutter,
    feedbackTheme
  ];
}

// Helper functions to control the decorations from outside
export function showFeedbackDecorationsInView(view: EditorView, changes: CodocMergeChange[]) {  
  view.dispatch({
    effects: setFeedbackDecorations.of(changes)
  });
}

export function clearFeedbackDecorationsInView(view: EditorView) {
  view.dispatch({
    effects: clearFeedbackDecorations.of()
  });
}

// Helper function to reject a specific change
export function rejectFeedbackChangeInView(view: EditorView, changeId: string) {
  view.dispatch({
    effects: rejectFeedbackChange.of({ changeId })
  });
}
