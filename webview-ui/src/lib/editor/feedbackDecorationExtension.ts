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

export interface CodocMergeChange {
  type: 'add' | 'modify' | 'remove';
  element: {
    type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
    name: string;
    path?: string;
  };
  content?: string;
  lineNumber?: number;
  indentLevel?: number;
  id?: string; // Unique identifier for the change
  originalContent?: string; // For reverting changes
}

// State effect to set feedback decorations (ACCUMULATES changes across generations)
export const setFeedbackDecorations = StateEffect.define<CodocMergeChange[]>();

// State effect to add feedback decorations (MERGES with existing, for incremental updates)
export const addFeedbackDecorations = StateEffect.define<CodocMergeChange[]>();

// State effect to clear feedback decorations (only used when generate button is pressed)
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
        // REPLACE all changes (used for initial feedback or when content changes significantly)
        return effect.value.map((change, index) => ({
          ...change,
          id: change.id || `change-${Date.now()}-${index}`
        }));
      }
      if (effect.is(addFeedbackDecorations)) {
        // MERGE new changes with existing ones (for incremental generation)
        const newChanges = effect.value.map((change, index) => ({
          ...change,
          id: change.id || `change-${Date.now()}-${index}`
        }));
        // Remove duplicates based on element name and type, keeping the newer ones
        const existingMap = new Map(changes.map(c => [`${c.element.type}:${c.element.name}`, c]));
        newChanges.forEach(nc => existingMap.set(`${nc.element.type}:${nc.element.name}`, nc));
        return Array.from(existingMap.values());
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

// Widget for deleted content (similar to deletionWidget)
class FeedbackDeletionWidget extends WidgetType {
  constructor(private content: string, private elementName: string, private changeId: string, private view: EditorView) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-feedbackDeletedChunk";
    
    // Add reject button container
    const buttonContainer = dom.appendChild(document.createElement("div"));
    buttonContainer.className = "cm-feedbackButtonContainer";
    
    const rejectButton = buttonContainer.appendChild(document.createElement("button"));
    rejectButton.className = "cm-feedbackRejectButton";
    rejectButton.textContent = "✕";
    rejectButton.title = "Restore this content";
    rejectButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('rejecting change', this.changeId);
      this.view.dispatch({
        effects: rejectFeedbackChange.of({ changeId: this.changeId })
      });
      // Dispatch custom event for parent component to handle content restoration
      window.dispatchEvent(new CustomEvent('feedbackChangeRejected', {
        detail: { changeId: this.changeId, type: 'remove', content: this.content, elementName: this.elementName }
      }));
    };
    
    if (this.content.trim()) {
      const contentDiv = dom.appendChild(document.createElement("div"));
      contentDiv.className = "cm-feedbackDeletedContent";
      
      // Split content into lines and add strikethrough
      const lines = this.content.split('\n');
      lines.forEach((line, index) => {
        if (index > 0) {
          contentDiv.appendChild(document.createElement("br"));
        }
        const lineSpan = contentDiv.appendChild(document.createElement("del"));
        lineSpan.className = "cm-feedbackDeletedText";
        lineSpan.textContent = line;
      });
    }
    
    return dom;
  }

  get estimatedHeight() {
    const lines = this.content.split('\n').length;
    return Math.max(40, lines * 20 + 30); // Header + content
  }
}

// Widget for hover buttons on added/modified lines
class FeedbackHoverButtonWidget extends WidgetType {
  constructor(private changeType: 'add' | 'modify', private changeId: string, private view: EditorView, private originalContent?: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-feedbackHoverButton";
    
    const button = dom.appendChild(document.createElement("button"));
    button.className = "cm-feedbackRejectButton";
    button.textContent = this.changeType === 'add' ? "✕" : "↶";
    button.title = this.changeType === 'add' ? "Remove this addition" : "Revert this change";
    button.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.view.dispatch({
        effects: rejectFeedbackChange.of({ changeId: this.changeId })
      });
      // Dispatch custom event for parent component to handle content restoration
      window.dispatchEvent(new CustomEvent('feedbackChangeRejected', {
        detail: { 
          changeId: this.changeId, 
          type: this.changeType, 
          originalContent: this.originalContent 
        }
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
    
    // Prioritize changes: remove > modify > add
    const sortedLineChanges = lineChanges.sort((a, b) => {
      const priority: { [key: string]: number } = { 'remove': 3, 'modify': 2, 'add': 1 };
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
          widget: new FeedbackHoverButtonWidget('add', primaryChange.id || 'unknown', view),
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
          widget: new FeedbackHoverButtonWidget('modify', primaryChange.id || 'unknown', view, primaryChange.originalContent),
          side: 1
        });
        builder.add(line.to, line.to, modifyHoverWidget);
        break;
        
      case 'remove':
        // For removals, we create a widget to show the deleted content
        const deletionWidget = Decoration.widget({
          widget: new FeedbackDeletionWidget(
            primaryChange.content || '', 
            primaryChange.element.name,
            primaryChange.id || 'unknown',
            view
          ),
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
  
  // Removed line styling (red with strikethrough effect)
  ".cm-feedbackRemovedLine": {
    backgroundColor: "rgba(238, 68, 51, 0.1)",
  },
  
  // Deleted content widget
  ".cm-feedbackDeletedChunk": {
    backgroundColor: "rgba(238, 68, 51, 0.05)",
    border: "1px solid rgba(238, 68, 51, 0.2)",
    borderRadius: "4px",
    position: "relative",
  },
  
  ".cm-feedbackDeletedContent": {
    fontFamily: "monospace",
    fontSize: "0.9em",
    lineHeight: "1.4"
  },
  
  ".cm-feedbackDeletedText": {
    textDecoration: "line-through",
    color: "#666",
    opacity: 0.8
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
  
  ".cm-feedbackAddedLine:hover .cm-feedbackHoverButton, .cm-feedbackModifiedLine:hover .cm-feedbackHoverButton": {
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
  
  "&dark .cm-feedbackRemovedLine": {
    backgroundColor: "rgba(238, 68, 51, 0.15)",
  },
  
  "&dark .cm-feedbackDeletedChunk": {
    backgroundColor: "rgba(238, 68, 51, 0.08)",
    border: "1px solid rgba(238, 68, 51, 0.3)"
  },
  
  "&dark .cm-feedbackDeletedHeader": {
    color: "#ff6655"
  },
  
  "&dark .cm-feedbackDeletedText": {
    color: "#999"
  },
  
  "&dark .cm-feedbackAddedGutter": {
    background: "#44dd44"
  },
  
  "&dark .cm-feedbackModifiedGutter": {
    background: "#ffbb33"
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
  // console.log('🎨 [FeedbackDecorations] Changes:', changes.map(c => `${c.element.name} (${c.type}) line:${c.lineNumber}: ${c.content}`));
  
  view.dispatch({
    effects: setFeedbackDecorations.of(changes)
  });
}

// Add new changes to existing decorations (for incremental generation)
export function addFeedbackDecorationsInView(view: EditorView, changes: CodocMergeChange[]) {
  view.dispatch({
    effects: addFeedbackDecorations.of(changes)
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
