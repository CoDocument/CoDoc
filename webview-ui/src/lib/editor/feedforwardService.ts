import {
  ViewPlugin,
  DecorationSet,
  EditorView,
  ViewUpdate,
  Decoration,
  WidgetType,
} from "@codemirror/view";
import {
  StateEffect,
  Text,
  StateField,
  EditorState,
  EditorSelection,
  Annotation
} from "@codemirror/state";

// Annotation for marking feedforward acceptance transactions
const feedforwardAcceptAnnotation = Annotation.define<boolean>();

export interface FeedforwardSuggestion {
  text: string;
  insertLine: number;
  indentLevel: number;
  type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
  // position: string;
  id: string;
  fullPath: string;
  parent?: string;
  groupId?: string;
  groupItems?: string[];
  sequence?: number;
  contextPath?: string; // Path to existing file/directory where suggestion should be added
}

export interface FeedforwardResult {
  suggestions: FeedforwardSuggestion[];
}

// State effects for managing feedforward
const addFeedforwardEffect = StateEffect.define<{
  suggestions: FeedforwardSuggestion[];
  doc: Text;
}>();

const clearFeedforwardEffect = StateEffect.define<void>();
const acceptSuggestionEffect = StateEffect.define<string>();
const highlightSuggestionEffect = StateEffect.define<string | null>();
const setNavigatingEffect = StateEffect.define<boolean>();

// State field to manage feedforward state
const feedforwardState = StateField.define<{
  suggestions: FeedforwardSuggestion[];
  acceptedSuggestions: Set<string>;
  highlightedSuggestion: string | null;
  isNavigating: boolean;
  rejectedPatterns: Set<string>;
}>({
  create: () => ({
    suggestions: [],
    acceptedSuggestions: new Set(),
    highlightedSuggestion: null,
    isNavigating: false,
    rejectedPatterns: new Set()
  }),
  update(value, tr) {
    let newValue = { ...value };

    for (const effect of tr.effects) {
      if (effect.is(addFeedforwardEffect)) {
        newValue.suggestions = effect.value.suggestions;
        newValue.acceptedSuggestions = new Set();
        newValue.highlightedSuggestion = null;
        // Set to false so suggestions are visible immediately without pressing Alt
        newValue.isNavigating = false;
      } else if (effect.is(clearFeedforwardEffect)) {
        newValue.suggestions = [];
        newValue.acceptedSuggestions = new Set();
        newValue.highlightedSuggestion = null;
        newValue.isNavigating = false;
      } else if (effect.is(acceptSuggestionEffect)) {
        newValue.acceptedSuggestions = new Set(newValue.acceptedSuggestions);
        newValue.acceptedSuggestions.add(effect.value);
      } else if (effect.is(highlightSuggestionEffect)) {
        newValue.highlightedSuggestion = effect.value;
      } else if (effect.is(setNavigatingEffect)) {
        newValue.isNavigating = effect.value;
      }
    }

    // Check for feedforward accept annotations
    if (tr.annotation(feedforwardAcceptAnnotation)) {
      return newValue;
    }

    return newValue;
  }
});

/**
 * Widget for displaying feedforward suggestions
 */
class FeedforwardLineWidget extends WidgetType {
  constructor(
    readonly suggestion: FeedforwardSuggestion,
    readonly isHighlighted: boolean,
    readonly isAccepted: boolean,
    readonly isVisible: boolean
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-feedforwardSuggestion';
    
    if (!this.isVisible) {
      container.style.display = 'none';
    }
    
    // Dark mode: black background with gray text
    container.style.backgroundColor = '#000000';
    container.style.color = '#808080';
    container.style.borderLeft = '3px solid #333333';
    
    if (this.isAccepted) {
      container.style.borderLeft = '3px solid #666666';
      container.style.opacity = '0.7';
    } else if (this.isHighlighted) {
      container.style.borderLeft = '3px solid #555555';
    }

    const indent = '  '.repeat(Math.max(0, this.suggestion.indentLevel));
    const code = document.createElement('pre');
    code.className = 'cm-feedforwardSuggestionCode';
    code.style.color = '#808080';
    code.style.backgroundColor = '#000000';
    code.textContent = indent + this.suggestion.text.trim();
    container.appendChild(code);

    return container;
  }

  eq(other: FeedforwardLineWidget): boolean {
    return (
      this.suggestion.id === other.suggestion.id &&
      this.isHighlighted === other.isHighlighted &&
      this.isAccepted === other.isAccepted &&
      this.isVisible === other.isVisible
    );
  }

  get estimatedHeight(): number {
    return 24;
  }
}

/**
 * Calculate insertion position for dynamic line
 */
function calculateInsertionPositionForDynamicLine(
  state: EditorState, 
  dynamicLine: number
): number {
  const doc = state.doc;
  const targetLine = Math.min(Math.max(dynamicLine, 1), doc.lines);

  if (targetLine <= doc.lines) {
    const line = doc.line(targetLine);
    return line.to;
  }

  return doc.length;
}

/**
 * Format suggestion for insertion
 */
function formatSuggestionText(suggestion: FeedforwardSuggestion): string {
  const indent = '  '.repeat(Math.max(0, suggestion.indentLevel));
  
  if (suggestion.groupItems && suggestion.groupItems.length > 1) {
    return '\n' + suggestion.groupItems.map(item => {
      const itemTrimmed = item.trim();
      return indent + itemTrimmed;
    }).join('\n');
  }
  
  return '\n' + indent + suggestion.text.trim();
}

/**
 * Enhanced plugin with Alt+Tab navigation
 */
const feedforwardPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    ctrlShiftPressed = false;
    handleKeyDown?: (e: KeyboardEvent) => void;
    handleKeyUp?: (e: KeyboardEvent) => void;

    constructor(view: EditorView) {
      this.decorations = Decoration.none;
      this.setupEventListeners(view);
      // Build initial decorations
      this.buildDecorations(view);
    }

    setupEventListeners(view: EditorView) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (this.ctrlShiftPressed) {
          e.preventDefault();
        }
        if (e.altKey && !this.ctrlShiftPressed) {
          e.preventDefault();
          this.ctrlShiftPressed = true;
          // Enable navigation mode when Alt is pressed
          view.dispatch({
            effects: setNavigatingEffect.of(true)
          });
          this.buildDecorations(view); // Rebuild decorations when Alt is pressed
          this.updateHighlight(view);
        } else if (this.ctrlShiftPressed && e.key === 'Tab') {
          e.preventDefault();
          const state = view.state.field(feedforwardState);

          if (!state.highlightedSuggestion) return false;

          const suggestion = state.suggestions.find(s => s.id === state.highlightedSuggestion);
          if (!suggestion) return false;

          view.dispatch({
            effects: [acceptSuggestionEffect.of(suggestion.id)]
          });

          this.updateHighlight(view);
          return true;
        } else if (this.ctrlShiftPressed && e.key === 'ArrowRight') {
          e.preventDefault();
          const state = view.state.field(feedforwardState);

          if (!state.isNavigating || state.suggestions.length === 0) return false;

          const availableSuggestions = state.suggestions.filter(s => !state.acceptedSuggestions.has(s.id));
          if (availableSuggestions.length === 0) return false;

          const currentIndex = state.highlightedSuggestion ?
            availableSuggestions.findIndex(s => s.id === state.highlightedSuggestion) : -1;

          const nextIndex = (currentIndex + 1) % availableSuggestions.length;
          const nextSuggestion = availableSuggestions[nextIndex];

          if (nextSuggestion) {
            view.dispatch({
              effects: highlightSuggestionEffect.of(null)
            });
            
            setTimeout(() => {
              view.dispatch({
                effects: highlightSuggestionEffect.of(nextSuggestion.id)
              });
            }, 10);
          }

          return true;
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        if (!e.altKey && this.ctrlShiftPressed) {
          e.preventDefault();
          this.ctrlShiftPressed = false;
          
          const state = view.state.field(feedforwardState);
          
          if (state.acceptedSuggestions.size > 0) {
            this.insertAllAcceptedSuggestions(view, state);
          } else {
            // Disable navigation mode when Alt is released
            view.dispatch({
              effects: setNavigatingEffect.of(false)
            });
          }
          
          // Rebuild decorations after Alt is released
          this.buildDecorations(view);
        }
      };

      this.handleKeyDown = handleKeyDown;
      this.handleKeyUp = handleKeyUp;

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
    }

    findClosestSuggestion(
      suggestions: FeedforwardSuggestion[],
      acceptedSuggestions: Set<string>,
      cursorLine: number
    ): FeedforwardSuggestion | null {
      const available = suggestions.filter(s => !acceptedSuggestions.has(s.id));
      if (available.length === 0) return null;

      let closest = available[0];
      let minDistance = Math.abs(closest.insertLine - cursorLine);

      for (const suggestion of available) {
        const distance = Math.abs(suggestion.insertLine - cursorLine);
        if (distance < minDistance) {
          minDistance = distance;
          closest = suggestion;
        }
      }

      return closest;
    }

    insertAllAcceptedSuggestions(view: EditorView, state: any) {
      const acceptedSuggestions = Array.from(state.acceptedSuggestions)
        .map(id => state.suggestions.find((s: FeedforwardSuggestion) => s.id === id))
        .filter(Boolean) as FeedforwardSuggestion[];

      if (acceptedSuggestions.length === 0) return;

      // Sort bottom-up for insertion
      const bottomUp = [...acceptedSuggestions].sort((a, b) => {
        if (b.insertLine !== a.insertLine) return b.insertLine - a.insertLine;
        if (b.sequence !== undefined && a.sequence !== undefined) {
          return a.sequence - b.sequence;
        }
        return b.indentLevel - a.indentLevel;
      });

      let lastSelectionPos: number | null = null;

      for (const suggestion of bottomUp) {
        const insertPos = calculateInsertionPositionForDynamicLine(view.state, suggestion.insertLine);
        const insertText = formatSuggestionText(suggestion);

        view.dispatch({
          changes: { from: insertPos, to: insertPos, insert: insertText },
          annotations: [feedforwardAcceptAnnotation.of(true)]
        });

        const endPos = insertPos + insertText.length;
        lastSelectionPos = lastSelectionPos === null ? endPos : Math.max(lastSelectionPos, endPos);
      }

      if (lastSelectionPos !== null) {
        view.dispatch({
          selection: EditorSelection.cursor(lastSelectionPos),
          effects: [clearFeedforwardEffect.of()]
        });
      } else {
        view.dispatch({ effects: [clearFeedforwardEffect.of()] });
      }
    }

    updateHighlight(view: EditorView) {
      const state = view.state.field(feedforwardState);
      if (state.suggestions.length === 0) return;

      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      const closest = this.findClosestSuggestion(state.suggestions, state.acceptedSuggestions, cursorLine);

      if (closest) {
        view.dispatch({
          effects: highlightSuggestionEffect.of(closest.id)
        });
      }
    }

    update(update: ViewUpdate) {
      // Check if feedforward state changed or if document changed
      let stateChanged = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(addFeedforwardEffect) || 
              effect.is(clearFeedforwardEffect) || 
              effect.is(acceptSuggestionEffect) || 
              effect.is(highlightSuggestionEffect) ||
              effect.is(setNavigatingEffect)) {
            stateChanged = true;
            break;
          }
        }
        if (stateChanged) break;
      }

      // Rebuild decorations if state changed
      if (stateChanged || update.docChanged) {
        this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView, state?: any) {
      if (!state) {
        try {
          state = view.state.field(feedforwardState);
        } catch (e) {
          this.decorations = Decoration.none;
          return;
        }
      }

      if (state.suggestions.length === 0) {
        this.decorations = Decoration.none;
        return;
      }

      const decorationData: Array<{decoration: any, position: number}> = [];

      for (const suggestion of state.suggestions) {
        const isAccepted = state.acceptedSuggestions.has(suggestion.id);
        const isHighlighted = state.highlightedSuggestion === suggestion.id;
        
        // Show suggestion if:
        // - NOT navigating (show all by default)
        // - OR it's highlighted (during navigation)
        // - OR Alt key is pressed (during navigation)
        // - OR it's accepted (always show accepted)
        const isVisible = !state.isNavigating || isHighlighted || this.ctrlShiftPressed || isAccepted;

        const doc = view.state.doc;
        let targetLine: number = suggestion.insertLine;
        
        targetLine = Math.min(Math.max(targetLine, 1), doc.lines);
        const line = doc.line(targetLine);

        const widget = new FeedforwardLineWidget(suggestion, isHighlighted, isAccepted, isVisible);
        const decoration = Decoration.widget({
          widget,
          side: 1
        });

        decorationData.push({
          decoration: decoration.range(line.to),
          position: line.to
        });
      }

      decorationData.sort((a, b) => a.position - b.position);
      this.decorations = Decoration.set(decorationData.map(d => d.decoration));
    }

    destroy() {
      if (this.handleKeyDown) {
        window.removeEventListener('keydown', this.handleKeyDown);
      }
      if (this.handleKeyUp) {
        window.removeEventListener('keyup', this.handleKeyUp);
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

/**
 * Theme for feedforward suggestions - Dark mode with black background and gray text
 */
const feedforwardTheme = EditorView.baseTheme({
  ".cm-feedforwardSuggestion": {
    margin: "2px 0",
    padding: "4px 8px",
    borderRadius: "3px",
    fontFamily: "inherit",
    fontSize: "0.95em",
    lineHeight: "1.3",
    color: "#808080",
    backgroundColor: "#000000",
    border: "1px solid #333333",
    position: "relative",
    transition: "all 0.2s ease"
  },
  ".cm-feedforwardSuggestionCode": {
    margin: "0",
    whiteSpace: "pre",
    fontFamily: "inherit",
    color: "#808080",
    backgroundColor: "#000000"
  },
  "&dark .cm-feedforwardSuggestion": {
    color: "#808080",
    backgroundColor: "#000000"
  }
});

export function feedforwardExtension() {
  return [feedforwardState, feedforwardPlugin, feedforwardTheme];
}

export function addFeedforwardSuggestions(view: EditorView, suggestions: FeedforwardSuggestion[]) {
  view.dispatch({
    effects: addFeedforwardEffect.of({
      suggestions,
      doc: view.state.doc
    })
  });
}

export function clearFeedforwardSuggestions(view: EditorView) {
  view.dispatch({
    effects: clearFeedforwardEffect.of()
  });
}

export function getFeedforwardState(view: EditorView) {
  return view.state.field(feedforwardState);
}


/**
 * Apply feedforward suggestions to the editor
 * Expects suggestions to already be properly formatted from backend
 */
export function applyFeedforwardSuggestions(view: EditorView, suggestions: FeedforwardSuggestion[]) {
  console.log('[FRONTEND] Applying feedforward suggestions:', suggestions);
  
  // Validate suggestions have required fields
  const validSuggestions = suggestions.filter(s => 
    s.id && s.text && typeof s.insertLine === 'number' && typeof s.indentLevel === 'number'
  );

  if (validSuggestions.length !== suggestions.length) {
    console.warn('[FRONTEND] Some suggestions were invalid and filtered out');
  }

  addFeedforwardSuggestions(view, validSuggestions);
}
