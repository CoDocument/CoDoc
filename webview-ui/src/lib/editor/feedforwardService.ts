import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap
} from "@codemirror/view";
import {
  RangeSetBuilder,
  StateEffect,
  StateField
} from "@codemirror/state";
import type { SuggestedChange } from "../../types";

interface FeedforwardEntry {
  id: string;
  syntax: string;
  reason: string;
  insertLine: number;
  indentLevel: number;
}

const setFeedforwardSuggestionsEffect = StateEffect.define<FeedforwardEntry[]>();
const clearFeedforwardSuggestionsEffect = StateEffect.define<void>();
const acceptFeedforwardSuggestionEffect = StateEffect.define<string>(); // Accept by ID

const feedforwardState = StateField.define<FeedforwardEntry[]>({
  create() {
    return [];
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFeedforwardSuggestionsEffect)) {
        return effect.value;
      }
      if (effect.is(clearFeedforwardSuggestionsEffect)) {
        return [];
      }
      if (effect.is(acceptFeedforwardSuggestionEffect)) {
        // Remove accepted suggestion
        return value.filter(entry => entry.id !== effect.value);
      }
    }

    if (transaction.docChanged) {
      return [];
    }

    return value;
  }
});

function clampIndent(level: number): number {
  if (!Number.isFinite(level) || level < 0) {
    return 0;
  }
  return Math.min(level, 8);
}

/**
 * Accept a feedforward suggestion by inserting its content into the document
 */
function acceptSuggestion(view: EditorView, entry: FeedforwardEntry) {
  const doc = view.state.doc;
  const targetLineNumber = Math.min(entry.insertLine, doc.lines);
  const targetLine = doc.line(targetLineNumber);
  
  // Insert the suggestion at the end of the target line
  const insertPos = targetLine.to;
  const indent = "  ".repeat(clampIndent(entry.indentLevel));
  const textToInsert = `\n${indent}${entry.syntax}`;
  
  view.dispatch({
    changes: { from: insertPos, insert: textToInsert },
    effects: acceptFeedforwardSuggestionEffect.of(entry.id)
  });
}

function buildDecorations(view: EditorView, entries: FeedforwardEntry[]): DecorationSet {
  if (entries.length === 0) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const lastLine = Math.max(1, doc.lines);

  for (const entry of entries) {
    const withinDocument = entry.insertLine >= 1 && entry.insertLine <= doc.lines;
    const targetLineNumber = withinDocument ? entry.insertLine : lastLine;
    const targetLine = doc.line(Math.max(1, targetLineNumber));
    const appendToEnd = entry.insertLine > doc.lines || doc.length === 0;
    const insertPos = appendToEnd ? doc.length : targetLine.to;

    if (withinDocument) {
      builder.add(
        targetLine.from,
        targetLine.from,
        Decoration.line({
          class: "cm-feedforwardLine",
          attributes: { "data-feedforward-id": entry.id }
        })
      );
    }

    builder.add(
      insertPos,
      insertPos,
      Decoration.widget({
        widget: new FeedforwardWidget(entry),
        side: 1,
        block: true
      })
    );
  }

  return builder.finish();
}

class FeedforwardWidget extends WidgetType {
  private readonly entry: FeedforwardEntry;

  constructor(entry: FeedforwardEntry) {
    super();
    this.entry = entry;
  }

  override toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-feedforwardSuggestion";
    container.setAttribute("data-suggestion-id", this.entry.id);

    if (this.entry.reason) {
      container.title = this.entry.reason;
    }

    // Add accept button
    const acceptButton = document.createElement("button");
    acceptButton.className = "cm-feedforwardAcceptButton";
    acceptButton.textContent = "✓";
    acceptButton.title = "Accept suggestion (Tab or Ctrl+↓)";
    acceptButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      acceptSuggestion(view, this.entry);
    };
    container.appendChild(acceptButton);

    const code = document.createElement("pre");
    code.className = "cm-feedforwardSuggestionCode";
    code.textContent = `${"  ".repeat(clampIndent(this.entry.indentLevel))}${this.entry.syntax}`;
    container.appendChild(code);

    if (this.entry.reason) {
      const reason = document.createElement("div");
      reason.className = "cm-feedforwardSuggestionReason";
      reason.textContent = this.entry.reason;
      container.appendChild(reason);
    }

    return container;
  }

  override eq(other: FeedforwardWidget): boolean {
    return (
      this.entry.id === other.entry.id &&
      this.entry.syntax === other.entry.syntax &&
      this.entry.reason === other.entry.reason &&
      this.entry.indentLevel === other.entry.indentLevel &&
      this.entry.insertLine === other.entry.insertLine
    );
  }

  override ignoreEvent(): boolean {
    return false; // Allow click events
  }

  override get estimatedHeight(): number {
    return this.entry.reason ? 50 : 34;
  }
}

const feedforwardPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, view.state.field(feedforwardState));
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.transactions.some(tr =>
          tr.effects.some(effect =>
            effect.is(setFeedforwardSuggestionsEffect) || effect.is(clearFeedforwardSuggestionsEffect)
          )
        )
      ) {
        this.decorations = buildDecorations(update.view, update.state.field(feedforwardState));
      }
    }
  },
  {
    decorations: instance => instance.decorations
  }
);

const feedforwardTheme = EditorView.baseTheme({
  ".cm-feedforwardLine": {
    backgroundColor: "rgba(14, 165, 233, 0.08)"
  },
  ".cm-feedforwardSuggestion": {
    margin: "4px 0",
    padding: "6px 10px",
    paddingRight: "40px",
    borderRadius: "4px",
    borderLeft: "3px solid rgba(14, 165, 233, 0.45)",
    backgroundColor: "rgba(14, 165, 233, 0.1)",
    fontFamily: "inherit",
    fontSize: "0.95em",
    lineHeight: "1.4",
    color: "inherit",
    position: "relative"
  },
  ".cm-feedforwardAcceptButton": {
    position: "absolute",
    top: "6px",
    right: "8px",
    padding: "4px 8px",
    backgroundColor: "rgba(34, 197, 94, 0.8)",
    color: "white",
    border: "none",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: "bold",
    transition: "background-color 0.2s ease",
    zIndex: "10"
  },
  ".cm-feedforwardAcceptButton:hover": {
    backgroundColor: "rgba(34, 197, 94, 1)"
  },
  ".cm-feedforwardSuggestionCode": {
    margin: "0",
    whiteSpace: "pre",
    fontFamily: "inherit"
  },
  ".cm-feedforwardSuggestionReason": {
    marginTop: "4px",
    fontSize: "0.75rem",
    opacity: "0.75"
  },
  "&dark .cm-feedforwardLine": {
    backgroundColor: "rgba(56, 189, 248, 0.12)"
  },
  "&dark .cm-feedforwardSuggestion": {
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderLeft: "3px solid rgba(56, 189, 248, 0.6)"
  },
  "&dark .cm-feedforwardAcceptButton": {
    backgroundColor: "rgba(74, 222, 128, 0.8)"
  },
  "&dark .cm-feedforwardAcceptButton:hover": {
    backgroundColor: "rgba(74, 222, 128, 1)"
  }
});

/**
 * Find the nearest feedforward suggestion to the cursor
 */
function findNearestSuggestion(view: EditorView): FeedforwardEntry | null {
  const suggestions = view.state.field(feedforwardState);
  if (suggestions.length === 0) return null;
  
  const cursorPos = view.state.selection.main.head;
  const cursorLine = view.state.doc.lineAt(cursorPos).number;
  
  // Find suggestion on current line or closest below
  let nearest: FeedforwardEntry | null = null;
  let minDistance = Infinity;
  
  for (const suggestion of suggestions) {
    const distance = Math.abs(suggestion.insertLine - cursorLine);
    if (distance < minDistance || (distance === minDistance && suggestion.insertLine >= cursorLine)) {
      minDistance = distance;
      nearest = suggestion;
    }
  }
  
  return nearest;
}

/**
 * Keyboard shortcut handlers for accepting suggestions
 */
const feedforwardKeymap = keymap.of([
  {
    key: "Tab",
    run: (view) => {
      const suggestion = findNearestSuggestion(view);
      if (suggestion) {
        acceptSuggestion(view, suggestion);
        return true;
      }
      return false;
    }
  },
  {
    key: "Ctrl-ArrowDown",
    run: (view) => {
      const suggestion = findNearestSuggestion(view);
      if (suggestion) {
        acceptSuggestion(view, suggestion);
        return true;
      }
      return false;
    }
  },
  {
    key: "Cmd-ArrowDown", // Mac
    run: (view) => {
      const suggestion = findNearestSuggestion(view);
      if (suggestion) {
        acceptSuggestion(view, suggestion);
        return true;
      }
      return false;
    }
  }
]);

export function feedforwardExtension() {
  return [feedforwardState, feedforwardPlugin, feedforwardTheme, feedforwardKeymap];
}

export function applyFeedforwardSuggestions(view: EditorView, suggestions: SuggestedChange[]) {
  const entries: FeedforwardEntry[] = suggestions.map((suggestion, index) => ({
    id: `${suggestion.codocSyntax}-${suggestion.insertLine}-${index}`,
    syntax: suggestion.codocSyntax.trim(),
    reason: suggestion.reason ?? "",
    insertLine: Number.isFinite(suggestion.insertLine) ? suggestion.insertLine : view.state.doc.lines + 1,
    indentLevel: clampIndent(suggestion.indentLevel ?? 0)
  }));

  view.dispatch({
    effects: setFeedforwardSuggestionsEffect.of(entries)
  });
}

export function clearFeedforwardSuggestions(view: EditorView) {
  view.dispatch({
    effects: clearFeedforwardSuggestionsEffect.of()
  });
}
