/**
 * Activity Gutter Extension for CodeMirror
 * Shows icons in the gutter indicating AI tool activities:
 * - 👀 Read: File was read by AI
 * - ✎ Edit: File/component was edited
 * - + Create: New file/component created
 * - ⌫ Delete: Something was removed
 */

import { 
  EditorView, 
  Decoration, 
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  gutter,
  GutterMarker
} from '@codemirror/view';
import { StateField, StateEffect, RangeSet } from '@codemirror/state';

// ============================================
// TYPES
// ============================================

export type GutterIconType = 'read' | 'edit' | 'create' | 'delete';

export interface GutterActivityDecoration {
  id: string;
  lineNumber: number;
  iconType: GutterIconType;
  tooltip: string;
  filePath?: string;
  componentName?: string;
  additions?: number;
  deletions?: number;
}

// ============================================
// STATE EFFECTS
// ============================================

export const addGutterActivity = StateEffect.define<GutterActivityDecoration>();
export const removeGutterActivity = StateEffect.define<string>(); // by id
export const clearGutterActivities = StateEffect.define<void>();

// ============================================
// GUTTER MARKERS
// ============================================

class ActivityGutterMarker extends GutterMarker {
  constructor(
    readonly iconType: GutterIconType,
    readonly tooltip: string,
    readonly additions?: number,
    readonly deletions?: number
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ActivityGutterMarker && 
           other.iconType === this.iconType &&
           other.tooltip === this.tooltip;
  }

  toDOM(): Node {
    const wrapper = document.createElement('div');
    wrapper.className = `activity-gutter-marker activity-${this.iconType}`;
    wrapper.title = this.tooltip;
    wrapper.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 100%;
      cursor: pointer;
      font-size: 11px;
    `;

    // Icon based on type
    const icon = document.createElement('span');
    switch (this.iconType) {
      case 'read':
        icon.textContent = '👀';
        icon.title = 'AI read this file';
        break;
      case 'edit':
        icon.textContent = '✎';
        icon.title = this.tooltip;
        break;
      case 'create':
        icon.textContent = '+';
        icon.title = 'AI created this';
        break;
      case 'delete':
        icon.textContent = '⌫';
        icon.title = 'AI removed this';
        break;
    }
    wrapper.appendChild(icon);

    // Add stats badge for edits
    if (this.iconType === 'edit' && (this.additions || this.deletions)) {
      const badge = document.createElement('span');
      badge.className = 'activity-stats-badge';
      badge.style.cssText = `
        position: absolute;
        right: -2px;
        top: -2px;
        font-size: 7px;
        line-height: 1;
        padding: 1px;
        color: var(--vscode-badge-background);
      `;
      
      const parts: string[] = [];
      if (this.additions && this.additions > 0) {
        parts.push(`+${this.additions}`);
      }
      if (this.deletions && this.deletions > 0) {
        parts.push(`-${this.deletions}`);
      }
      badge.textContent = parts.join(' ');
      wrapper.appendChild(badge);
    }

    return wrapper;
  }
}

// ============================================
// STATE FIELD
// ============================================

interface GutterActivityState {
  decorations: Map<string, GutterActivityDecoration>;
}

const gutterActivityState = StateField.define<GutterActivityState>({
  create() {
    return { decorations: new Map() };
  },
  
  update(state, tr) {
    let newDecorations = state.decorations;
    
    for (const effect of tr.effects) {
      if (effect.is(addGutterActivity)) {
        newDecorations = new Map(newDecorations);
        newDecorations.set(effect.value.id, effect.value);
      } else if (effect.is(removeGutterActivity)) {
        newDecorations = new Map(newDecorations);
        newDecorations.delete(effect.value);
      } else if (effect.is(clearGutterActivities)) {
        newDecorations = new Map();
      }
    }
    
    return { decorations: newDecorations };
  }
});

// ============================================
// GUTTER EXTENSION
// ============================================

/**
 * Create markers from state
 */
function createGutterMarkers(view: EditorView): Map<number, ActivityGutterMarker> {
  const markers = new Map<number, ActivityGutterMarker>();
  const state = view.state.field(gutterActivityState);
  
  for (const decoration of state.decorations.values()) {
    if (decoration.lineNumber > 0 && decoration.lineNumber <= view.state.doc.lines) {
      markers.set(decoration.lineNumber, new ActivityGutterMarker(
        decoration.iconType,
        decoration.tooltip,
        decoration.additions,
        decoration.deletions
      ));
    }
  }
  
  return markers;
}

/**
 * Activity gutter that shows tool usage icons
 */
const activityGutter = gutter({
  class: 'cm-activity-gutter',
  markers: (view) => {
    const markers = createGutterMarkers(view);
    const result: any[] = [];
    
    markers.forEach((marker, lineNumber) => {
      const line = view.state.doc.line(lineNumber);
      result.push(marker.range(line.from));
    });
    
    return RangeSet.of(result, true);
  }
});

// ============================================
// STYLES
// ============================================

const gutterStyles = EditorView.baseTheme({
  '.cm-activity-gutter': {
    width: '22px',
    backgroundColor: 'transparent'
  },
  '.cm-activity-gutter .cm-gutterElement': {
    padding: '0 2px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  '.activity-gutter-marker': {
    position: 'relative',
    opacity: '0.9',
    transition: 'opacity 0.2s, transform 0.2s'
  },
  '.activity-gutter-marker:hover': {
    opacity: '1',
    transform: 'scale(1.1)'
  },
  '.activity-read': {
    color: 'var(--vscode-charts-blue)'
  },
  '.activity-edit': {
    color: 'var(--vscode-charts-yellow)'
  },
  '.activity-create': {
    color: 'var(--vscode-charts-green)'
  },
  '.activity-delete': {
    color: 'var(--vscode-errorForeground)'
  }
});

// ============================================
// EXTENSION EXPORT
// ============================================

export function activityGutterExtension() {
  return [
    gutterActivityState,
    activityGutter,
    gutterStyles
  ];
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Add a gutter activity decoration
 */
export function addGutterActivityInView(
  view: EditorView,
  decoration: GutterActivityDecoration
): void {
  view.dispatch({
    effects: addGutterActivity.of(decoration)
  });
}

/**
 * Add multiple gutter activities at once
 */
export function addGutterActivitiesInView(
  view: EditorView,
  decorations: GutterActivityDecoration[]
): void {
  view.dispatch({
    effects: decorations.map(d => addGutterActivity.of(d))
  });
}

/**
 * Remove a specific gutter activity by ID
 */
export function removeGutterActivityInView(view: EditorView, id: string): void {
  view.dispatch({
    effects: removeGutterActivity.of(id)
  });
}

/**
 * Clear all gutter activities
 */
export function clearGutterActivitiesInView(view: EditorView): void {
  view.dispatch({
    effects: clearGutterActivities.of(undefined)
  });
}

/**
 * Find line number for a CoDoc element by path/name matching
 * Used when we only have filePath but need to find the line in CoDoc
 */
export function findLineForElement(
  view: EditorView,
  filePath: string,
  componentName?: string
): number | null {
  const doc = view.state.doc;
  const fileName = filePath.split('/').pop() || '';
  
  // Search through document lines
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text.trim();
    
    // Match file reference
    if (text.endsWith(fileName) || text.includes(fileName)) {
      return i;
    }
    
    // Match component name if provided
    if (componentName) {
      if (text === `%${componentName}` || 
          text === `$${componentName}()` ||
          text.includes(componentName)) {
        return i;
      }
    }
  }
  
  return null;
}
