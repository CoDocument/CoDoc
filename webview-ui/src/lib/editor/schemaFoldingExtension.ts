import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { foldService, foldEffect, unfoldEffect } from "@codemirror/language";

interface FoldableRange {
  from: number;
  to: number;
  type: 'directory' | 'file' | 'component' | 'function';
  indentLevel: number;
}

// Calculate indentation level
function getIndentLevel(lineText: string): number {
  const match = lineText.match(/^(\s*)/);
  return match ? Math.floor(match[1].length / 2) : 0;
}

// Find foldable ranges in the document
function findFoldableRanges(doc: any): FoldableRange[] {
  const ranges: FoldableRange[] = [];
  const lines = doc.toString().split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indentLevel = getIndentLevel(line);
    
    if (!trimmed) continue;
    
    let foldableType: FoldableRange['type'] | null = null;
    
    // Check if this line starts a foldable block
    if (trimmed.startsWith('/') && !trimmed.includes('.')) {
      foldableType = 'directory';
    } else if (trimmed.match(/\.(tsx?|jsx?|ts|js|json|css|scss|html|md|vue|py|java|cpp|c|go|rs|php|rb|swift|kt|dart)$/)) {
      foldableType = 'file';
    } else if (trimmed.startsWith('%')) {
      foldableType = 'component';
    } else if (trimmed.startsWith('$') && trimmed.includes('()')) {
      foldableType = 'function';
    }
    
    if (foldableType) {
      // Find the end of this foldable range
      const endLineIndex = findFoldableEnd(lines, i, indentLevel);
      
      if (endLineIndex > i) {
        const fromPos = doc.line(i + 1).from;
        const toPos = doc.line(endLineIndex + 1).to;
        
        ranges.push({
          from: fromPos,
          to: toPos,
          type: foldableType,
          indentLevel
        });
      }
    }
  }
  
  return ranges;
}

// Find the end line of a foldable block
function findFoldableEnd(lines: string[], startIndex: number, startIndentLevel: number): number {
  let endIndex = startIndex;
  
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) continue;
    
    const currentIndentLevel = getIndentLevel(line);
    
    // If we find a line with same or less indentation, this block ends
    if (currentIndentLevel <= startIndentLevel) {
      break;
    }
    
    // This line is part of the current block
    endIndex = i;
  }
  
  return endIndex;
}

// Custom fold service for schema structure
const schemaFoldService = StateField.define({
  create(state: EditorState) {
    return findFoldableRanges(state.doc);
  },
  
  update(value: FoldableRange[], tr) {
    if (tr.docChanged) {
      return findFoldableRanges(tr.state.doc);
    }
    return value;
  }
});

// Create foldable provider using the correct API
function schemaFoldableProvider(state: EditorState, lineStart: number, lineEnd: number) {
  const ranges = state.field(schemaFoldService, false);
  if (!ranges) return null;
  
  const doc = state.doc;
  const line = doc.lineAt(lineStart);
  const lineText = line.text;
  const trimmed = lineText.trim();
  const indentLevel = getIndentLevel(lineText);
  
  // Check if this line can be folded
  const canFold = 
    (trimmed.startsWith('/') && !trimmed.includes('.')) ||
    trimmed.match(/\.(tsx?|jsx?|ts|js|json|css|scss|html|md|vue|py|java|cpp|c|go|rs|php|rb|swift|kt|dart)$/) ||
    trimmed.startsWith('%') ||
    (trimmed.startsWith('$') && trimmed.includes('()'));
  
  if (!canFold) return null;
  
  // Find matching range
  const matchingRange = ranges.find(range => 
    range.from <= lineStart && range.to >= lineEnd && range.indentLevel === indentLevel
  );
  
  if (matchingRange && matchingRange.to > matchingRange.from) {
    return { from: line.to, to: matchingRange.to };
  }
  
  return null;
}

/**
 * Schema Folding Extension - adds folding capability for directories, files, components, and functions
 */
export function schemaFoldingExtension() {
  return [
    schemaFoldService,
    foldService.of(schemaFoldableProvider),

    ViewPlugin.fromClass(class {
      constructor(public view: EditorView) {}
      
      update(update: any) {
        // Handle any additional folding logic if needed
      }
    }),
    
    // Add custom keymap for folding
    EditorView.domEventHandlers({
      keydown(event: KeyboardEvent, view: EditorView) {
        // Ctrl+Shift+[ to fold
        if (event.ctrlKey && event.shiftKey && event.key === '[') {
          event.preventDefault();
          const { state } = view;
          const { selection } = state;
          const line = state.doc.lineAt(selection.main.head);
          
          const foldRange = schemaFoldableProvider(state, line.from, line.to);
          if (foldRange) {
            view.dispatch({
              effects: foldEffect.of(foldRange)
            });
          }
          return true;
        }
        
        // Ctrl+Shift+] to unfold
        if (event.ctrlKey && event.shiftKey && event.key === ']') {
          event.preventDefault();
          const { state } = view;
          const { selection } = state;
          const line = state.doc.lineAt(selection.main.head);
          
          view.dispatch({
            effects: unfoldEffect.of({ from: line.from, to: line.to })
          });
          return true;
        }
        
        return false;
      }
    })
  ];
}
