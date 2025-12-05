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


export type AgentActivityType = 'read' | 'write' | 'edit' | 'create';


// Create marker classes for different activity types
class ReadMarker extends GutterMarker {
  toDOM() {
    const element = document.createElement('div');
    element.className = 'cm-agent-activity-marker cm-read-marker';
    element.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
    </svg>`;
    element.title = 'Agent read this file';
    return element;
  }
}

class WriteMarker extends GutterMarker {
  toDOM() {
    const element = document.createElement('div');
    element.className = 'cm-agent-activity-marker cm-write-marker';
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <g clip-path="url(#clip0_429_11126)"> <path d="M9 4.00018H19V18.0002C19 19.1048 18.1046 20.0002 17 20.0002H9" stroke="#292929" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M12 15.0002L15 12.0002M15 12.0002L12 9.00018M15 12.0002H5" stroke="#292929" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path> </g> <defs> <clipPath id="clip0_429_11126"> <rect width="24" height="24" fill="white"></rect> </clipPath> </defs> </g></svg>`;
    element.title = 'Agent wrote to this file';
    return element;
  }
}

class EditMarker extends GutterMarker {
  toDOM() {
    const element = document.createElement('div');
    element.className = 'cm-agent-activity-marker cm-edit-marker';
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M4 5L15 5" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M4 8H15" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M4 11H11" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M18.4563 13.5423L13.9268 18.0719C13.6476 18.3511 13.292 18.5414 12.9048 18.6188L10.8153 19.0367L11.2332 16.9472C11.3106 16.5601 11.5009 16.2045 11.7801 15.9253L16.3096 11.3957M18.4563 13.5423L19.585 12.4135C19.9755 12.023 19.9755 11.3898 19.585 10.9993L18.8526 10.2669C18.4621 9.8764 17.8289 9.8764 17.4384 10.2669L16.3096 11.3957M18.4563 13.5423L16.3096 11.3957" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`;
    element.title = 'Agent edited this file';
    return element;
  }
}

class CreateMarker extends GutterMarker {
  toDOM() {
    const element = document.createElement('div');
    element.className = 'cm-agent-activity-marker cm-create-marker';
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M13 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V9M13 3L19 9M13 3V8C13 8.55228 13.4477 9 14 9H19M12 13V17M14 15H10" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`;
    element.title = 'Agent created this file';
    return element;
  }
}


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
    `;

    // SVG icon based on type
    const icon = document.createElement('span');
    icon.style.cssText = `
      width: 12px;
      height: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    switch (this.iconType) {
      case 'read':
        icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
        </svg>`;
        break;
      case 'edit':
        icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 5L15 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 8H15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 11H11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M18.4563 13.5423L13.9268 18.0719C13.6476 18.3511 13.292 18.5414 12.9048 18.6188L10.8153 19.0367L11.2332 16.9472C11.3106 16.5601 11.5009 16.2045 11.7801 15.9253L16.3096 11.3957M18.4563 13.5423L19.585 12.4135C19.9755 12.023 19.9755 11.3898 19.585 10.9993L18.8526 10.2669C18.4621 9.8764 17.8289 9.8764 17.4384 10.2669L16.3096 11.3957M18.4563 13.5423L16.3096 11.3957" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        break;
      case 'create':
        icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V9M13 3L19 9M13 3V8C13 8.55228 13.4477 9 14 9H19M12 13V17M14 15H10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        break;
      case 'delete':
        icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
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
