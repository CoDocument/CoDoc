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
import OpenAI from 'openai';
import { OPENAI_CONFIG } from '../../config/openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_CONFIG.apiKey,
  dangerouslyAllowBrowser: true,
});

// Annotation for marking feedforward acceptance transactions
const feedforwardAcceptAnnotation = Annotation.define<boolean>();

export interface FeedforwardSuggestion {
  text: string;
  insertLine: number;
  indentLevel: number;
  type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
  position: string;
  id: string;
  fullPath: string; // Full path like "/components/Login.tsx"
  parent?: string; // Parent element for nested suggestions
  groupId?: string; // ID for grouping related suggestions together
  groupItems?: string[]; // Array of items in the same group
  // Preserve original LLM order for stable insertion when multiple items share the same insert line
  sequence?: number;
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

// State effect for updating insertion positions after content changes
const updateInsertionPositionsEffect = StateEffect.define<{
  insertedLength: number;
  insertPosition: number;
}>();

// New state effects for intelligent cursor tracking
const setPendingRequestEffect = StateEffect.define<{
  cursorLine: number;
  cursorColumn: number;
  requestTime: number;
  content: string;
}>();

const setFocusStateEffect = StateEffect.define<boolean>();

// New state effect for updating group commit history
const updateGroupCommitHistoryEffect = StateEffect.define<{
  groupId: string;
  committedLines: number;
  insertionPoint: number;
}>();

// New state effect for setting next insertion line
const setNextInsertionLineEffect = StateEffect.define<number>();

// State field to manage feedforward state
const feedforwardState = StateField.define<{
  suggestions: FeedforwardSuggestion[];
  acceptedSuggestions: Set<string>;
  highlightedSuggestion: string | null;
  isNavigating: boolean;
  rejectedPatterns: Set<string>; // Track rejected patterns for context
  insertionOffsets: Array<{ position: number; length: number }>; // Track cumulative offsets
  pendingRequest: {
    cursorLine: number;
    cursorColumn: number;
    requestTime: number;
    content: string;
  } | null; // Track pending feedforward request position
  isEditorFocused: boolean; // Track editor focus state
  groupCommitHistory: Array<{ groupId: string; committedLines: number; insertionPoint: number }>; // Track actual commit history
  nextInsertionLine: number; // Dynamic insertion line based on actual commits
}>({
  create() {
    return {
      suggestions: [],
      acceptedSuggestions: new Set(),
      highlightedSuggestion: null,
      isNavigating: false,
      rejectedPatterns: new Set(),
      insertionOffsets: [],
      pendingRequest: null,
      isEditorFocused: true,
      groupCommitHistory: [],
      nextInsertionLine: 0
    };
  },
  update(state, tr) {
    const hasNewSuggestions = tr.effects.some(e => e.is(addFeedforwardEffect));
    const isAcceptingOrClearing = tr.effects.some(e => e.is(acceptSuggestionEffect) || e.is(clearFeedforwardEffect));
    const hasPositionUpdate = tr.effects.some(e => e.is(updateInsertionPositionsEffect));

    // Clear suggestions if user moves cursor during pending request or types
    if (tr.docChanged && !tr.annotation(feedforwardAcceptAnnotation) && !hasNewSuggestions && !isAcceptingOrClearing && !hasPositionUpdate) {
      // User is typing - clear everything and cancel pending requests
      return {
        ...state,
        suggestions: [],
        pendingRequest: null,
        highlightedSuggestion: null
      };
    }

    // Clear suggestions if cursor moves during pending request
    if (tr.selection && !tr.selection.eq(tr.startState.selection) && state.pendingRequest && !hasNewSuggestions && !isAcceptingOrClearing) {
      const selection = tr.state.selection.main;
      const cursorPos = selection.head;
      const line = tr.state.doc.lineAt(cursorPos);
      const lineNumber = line.number - 1;
      const column = cursorPos - line.from;

      // Check if cursor moved from pending request position
      if (lineNumber !== state.pendingRequest.cursorLine || 
          column !== state.pendingRequest.cursorColumn) {
        console.log('Cursor moved during pending request - clearing suggestions', {
          from: { line: state.pendingRequest.cursorLine, col: state.pendingRequest.cursorColumn },
          to: { line: lineNumber, col: column }
        });
        return {
          ...state,
          suggestions: [],
          pendingRequest: null,
          highlightedSuggestion: null
        };
      }
    }

    let newState = state;

    for (const effect of tr.effects) {
      if (effect.is(addFeedforwardEffect)) {
        // Only show suggestions if request is still valid
        if (state.pendingRequest && state.isEditorFocused) {
          const selection = tr.state.selection.main;
          const cursorPos = selection.head;
          const line = tr.state.doc.lineAt(cursorPos);
          const lineNumber = line.number - 1;
          const column = cursorPos - line.from;
          const currentContent = tr.state.doc.toString();

          // Check if cursor is still at the same position and content matches
          if (lineNumber === state.pendingRequest.cursorLine && 
              column === state.pendingRequest.cursorColumn &&
              currentContent === state.pendingRequest.content) {
            console.log('Showing feedforward suggestions - cursor position validated');
            newState = {
              ...newState,
              suggestions: effect.value.suggestions,
              pendingRequest: null // Clear pending request
            };
          } else {
            console.log('Ignoring feedforward suggestions - cursor/content changed', {
              cursorMatch: lineNumber === state.pendingRequest.cursorLine && column === state.pendingRequest.cursorColumn,
              contentMatch: currentContent === state.pendingRequest.content
            });
            // Don't show suggestions if position changed
            newState = {
              ...newState,
              pendingRequest: null
            };
          }
        } else {
          console.log('Ignoring feedforward suggestions - no pending request or editor not focused');
          // Don't show suggestions if no pending request or not focused
        }
      } else if (effect.is(clearFeedforwardEffect)) {
        // When clearing, remember rejected patterns
        const rejected = new Set(state.rejectedPatterns);
        state.suggestions.forEach(s => {
          if (!state.acceptedSuggestions.has(s.id)) {
            rejected.add(s.type + ':' + s.text.trim());
          }
        });
        newState = {
          ...newState,
          suggestions: [],
          acceptedSuggestions: new Set(),
          highlightedSuggestion: null,
          isNavigating: false,
          rejectedPatterns: rejected,
          insertionOffsets: [],
          pendingRequest: null
        };
      } else if (effect.is(acceptSuggestionEffect)) {
        const newAccepted = new Set(state.acceptedSuggestions);
        newAccepted.add(effect.value);
        
        // Don't clear suggestions when all are accepted - keep them for visual feedback
        // They will be cleared and inserted when Alt key is released
          newState = {
            ...newState,
            acceptedSuggestions: newAccepted,
            highlightedSuggestion: null
          };
      } else if (effect.is(highlightSuggestionEffect)) {
        newState = {
          ...newState,
          highlightedSuggestion: effect.value,
          isNavigating: effect.value !== null
        };
      } else if (effect.is(updateInsertionPositionsEffect)) {
        // Update insertion positions for remaining suggestions
        const { insertedLength, insertPosition } = effect.value;
        
        // Add this offset to our tracking
        const newOffsets = [...state.insertionOffsets, { position: insertPosition, length: insertedLength }];
        
        // Note: With the new targeted insertion logic, we don't need to update suggestion.insertLine
        // because calculateDynamicInsertionLine handles the positioning dynamically
        // This preserves the original insertLine values for proper relative positioning
        
        newState = {
          ...newState,
          insertionOffsets: newOffsets
        };
      } else if (effect.is(setPendingRequestEffect)) {
        newState = {
          ...newState,
          pendingRequest: effect.value,
          suggestions: [] // Clear existing suggestions when new request starts
        };
      } else if (effect.is(setFocusStateEffect)) {
        newState = {
          ...newState,
          isEditorFocused: effect.value
        };
        // Clear suggestions if editor loses focus
        if (!effect.value) {
          newState = {
            ...newState,
            suggestions: [],
            pendingRequest: null,
            highlightedSuggestion: null
          };
        }
      } else if (effect.is(updateGroupCommitHistoryEffect)) {
        newState = {
          ...newState,
          groupCommitHistory: [...newState.groupCommitHistory, effect.value]
        };
      } else if (effect.is(setNextInsertionLineEffect)) {
        newState = {
          ...newState,
          nextInsertionLine: effect.value
        };
      }
    }

    return newState;
  }
});

// Widget for displaying inline suggestions
class FeedforwardLineWidget extends WidgetType {
  constructor(
    public suggestion: FeedforwardSuggestion,
    public isHighlighted: boolean,
    public isAccepted: boolean = false,
    public isVisible: boolean = true
  ) {
    super();
  }

  toDOM() {
    const container = document.createElement("div");

    if (!this.isVisible) {
      container.style.cssText = `display: none;`;
      return container;
    }

    // Different styling for accepted vs unaccepted suggestions
    if (this.isAccepted) {
      // Accepted suggestions: look like normal code (black font, no italic)
      container.style.cssText = `
        opacity: 1;
        font-style: normal;
        color: #1f2937;
        background-color: rgba(34, 197, 94, 0.1);
        padding: 2px 8px;
        margin: 2px 0;
        border-radius: 3px;
        border-left: 3px solid #22c55e;
        white-space: pre;
        font-family: inherit;
        font-size: inherit;
        display: block !important;
        visibility: visible !important;
        transition: all 0.15s ease;
        cursor: default;
        position: relative;
      `;
    } else {
      // Unaccepted suggestions: italic, gray/blue styling
    container.style.cssText = `
      opacity: ${this.isHighlighted ? "1" : "0.6"};
      font-style: italic;
      color: ${this.isHighlighted ? "#0ea5e9" : "#9ca3af"};
      background-color: ${this.isHighlighted ? "rgba(14, 165, 233, 0.1)" : "transparent"};
      padding: ${this.isHighlighted ? "2px 8px" : "2px 4px"};
      margin: 2px 0;
      border-radius: 3px;
      border-left: 3px solid ${this.isHighlighted ? "#0ea5e9" : "transparent"};
      white-space: pre;
      font-family: inherit;
      font-size: inherit;
      display: block !important;
      visibility: visible !important;
      transition: all 0.15s ease;
      cursor: pointer;
      position: relative;
    `;
    }

    // Use proper spacing for indent (2 spaces per level)
    const indent = '  '.repeat(Math.max(0, this.suggestion.indentLevel));

    // If this is a grouped suggestion, display all items
    if (this.suggestion.groupItems && this.suggestion.groupItems.length > 1) {
      // For grouped items, each item should respect the individual indent levels
      container.textContent = this.suggestion.groupItems.map(item => {
        // Check if item already has its own indentation
        const itemTrimmed = item.trim();
        return indent + itemTrimmed;
      }).join('\n');
    } else {
      container.textContent = indent + this.suggestion.text.trim();
    }

    if (this.isAccepted) {
      container.title = `Accepted: ${this.suggestion.text} (will be inserted when Alt key is released)`;
    } else if (this.isHighlighted) {
      container.title = `Tab to accept: ${this.suggestion.text}`;
    }

    return container;
  }

  eq(other: FeedforwardLineWidget) {
    return this.suggestion.id === other.suggestion.id &&
      this.isHighlighted === other.isHighlighted &&
      this.isAccepted === other.isAccepted &&
      this.isVisible === other.isVisible;
  }
}

/**
 * Fix indent levels according to codoc syntax rules using proper tree structure
 */
function fixIndentLevels(
  items: Array<{
    text: string;
    indentLevel: number;
    path: string[];
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
  }>,
  baseIndent: number,
  existingStructure: any[],
  content: string,
  cursorLine: number
): Array<{
  text: string;
  indentLevel: number;
  path: string[];
  type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
}> {
  const fixedItems = [...items];
  
  // Build tree context from existing content around cursor
  const treeContext = buildTreeContextFromContent(content, cursorLine);
  
  console.log('Tree context for indentation:', {
    cursorLine: cursorLine + 1,
    baseIndent,
    treeContext
  });

  for (let i = 0; i < fixedItems.length; i++) {
    const item = fixedItems[i];
    
    // Calculate correct indent based on tree structure
    const correctIndent = calculateTreeBasedIndent(
      item,
      baseIndent,
      treeContext,
      existingStructure
    );
    
    fixedItems[i] = { ...item, indentLevel: correctIndent };
    
    console.log(`Fixed indent for ${item.text} (${item.type}): ${correctIndent}`);
  }

  return fixedItems;
}

/**
 * Build tree context from content around cursor position
 */
function buildTreeContextFromContent(content: string, cursorLine: number): {
  parentType: 'root' | 'directory' | 'file';
  parentIndent: number;
  parentText: string;
  ancestors: Array<{ type: string; indent: number; text: string }>;
} {
  const lines = content.split('\n');
  const ancestors: Array<{ type: string; indent: number; text: string }> = [];
  
  // Look backwards from cursor to find parent context
  let parentType: 'root' | 'directory' | 'file' = 'root';
  let parentIndent = 0;
  let parentText = '';
  
  const currentLineContent = lines[cursorLine] || '';
  const currentIndent = Math.floor(currentLineContent.search(/\S|$/) / 2);
  
  // Scan backwards to build ancestor chain
  for (let i = cursorLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    const lineIndent = Math.floor(line.search(/\S|$/) / 2);
    const trimmed = line.trim();
    
    // If we find a line with less or equal indent, it's a potential parent
    if (lineIndent <= currentIndent) {
      const lineType = analyzeSuggestionType(trimmed).type;
      
      ancestors.unshift({
        type: lineType,
        indent: lineIndent,
        text: trimmed
      });
      
      // Set immediate parent
      if (!parentText) {
        parentType = lineType === 'directory' ? 'directory' : 
                    lineType === 'file' ? 'file' : 'root';
        parentIndent = lineIndent;
        parentText = trimmed;
      }
      
      // Stop when we reach a line with significantly less indent
      if (lineIndent < currentIndent - 1) {
        break;
      }
    }
  }
  
  return {
    parentType,
    parentIndent,
    parentText,
    ancestors
  };
}

/**
 * Calculate tree-based indent level using proper parent-child relationships
 */
function calculateTreeBasedIndent(
  item: {
    text: string;
    path: string[];
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
  },
  baseIndent: number,
  treeContext: {
    parentType: 'root' | 'directory' | 'file';
    parentIndent: number;
    parentText: string;
    ancestors: Array<{ type: string; indent: number; text: string }>;
  },
  existingStructure: any[]
): number {
  const { parentType, parentIndent, parentText, ancestors } = treeContext;
  
  console.log(`Calculating indent for ${item.text} (${item.type}):`, {
    parentType,
    parentIndent,
    parentText,
    ancestorCount: ancestors.length
  });
  
  // Root directories should be at base indent or same level as parent directory
  if (item.type === 'directory') {
    if (item.text.startsWith('/')) {
      // Root directory
      if (parentType === 'root') {
        return baseIndent;
      } else if (parentType === 'directory') {
        // Same level as parent directory (sibling directories)
        return parentIndent;
      } else if (parentType === 'file') {
        // Directory under file context - should be at same level as parent directory
        // Polyfill for findLast: find the last directory ancestor from the end
        const parentDir = (() => {
          for (let i = ancestors.length - 1; i >= 0; i--) {
            if (ancestors[i].type === 'directory') return ancestors[i];
          }
          return undefined;
        })();
        const parentDirIndent = parentDir?.indent ?? baseIndent;
        return parentDirIndent;
      }
    } else {
      // Non-root directory - nested under current context
      return parentIndent + 1;
    }
  }
  
  // Files should be nested under directories
  else if (item.type === 'file') {
    if (parentType === 'directory') {
      return parentIndent + 1;
    } else if (parentType === 'file') {
      // File after file - should be at same level as previous file
      return parentIndent;
    } else {
      // File at root level
      return baseIndent + 1;
    }
  }
  
  // Functions, components, variables should be nested under files
  else if (['function', 'component', 'variable', 'reference'].includes(item.type)) {
    if (parentType === 'file') {
      return parentIndent + 1;
    } else if (parentType === 'directory') {
      // Function directly under directory - find the nearest file or use directory + 1
      // const nearestFile = ancestors.findLast(a => a.type === 'file');
      const nearestFile = (() => {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          if (ancestors[i].type === 'file') return ancestors[i];
        }
        return undefined;
      })();

      if (nearestFile) {
        return nearestFile.indent + 1;
      } else {
        return parentIndent + 1;
      }
    } else {
      // Function at root or under another function
      return parentIndent + 1;
    }
  }
  
  // Default fallback
  return baseIndent;
}


/**
 * Calculate smart insertion line based on cursor position and content structure
 * Returns the line number where new suggestions should appear (1-based)
 */
function calculateSmartInsertionLine(
  content: string,
  cursorLine: number,
  isForNewSuggestions: boolean = true
): number {
  const lines = content.split('\n');
  const currentLineContent = lines[cursorLine] || '';
  
  console.log('Calculating smart insertion line:', {
    cursorLine: cursorLine + 1, // 1-based for display
    currentLineContent: `"${currentLineContent}"`,
    isEmpty: currentLineContent.trim() === '',
    isForNewSuggestions
  });
  
  // For new suggestions, show at cursor position if current line is empty
  if (isForNewSuggestions && currentLineContent.trim() === '') {
    console.log('New suggestions on empty line - showing at cursor position');
    return cursorLine + 1; // Convert to 1-based line numbering
  }
  
  // For new suggestions on non-empty lines, anchor to current line end so the
  // widget renders directly under the current line (between current and next).
  if (isForNewSuggestions) {
    console.log('New suggestions on non-empty line - showing under current line');
    return cursorLine + 1; // Anchor to current line (1-based)
  }
  
  // For accepted suggestions (dynamic positioning), use the tree-aware logic
  const currentIndent = currentLineContent.search(/\S|$/);
  let insertLine = cursorLine + 2; // Default: line after current
  
  // Look ahead to see if there are any children
  let hasChildren = false;
  let lastChildLine = cursorLine;
  
  for (let i = cursorLine + 1; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.trim() === '') {
      continue; // Skip empty lines
    }
    
    const lineIndent = line.search(/\S|$/);
    
    // If we find a line at same or lesser indent, we're done with children
    if (lineIndent <= currentIndent) {
      insertLine = i + 1; // Insert before this sibling/parent (1-based)
      console.log(`Found sibling/parent at line ${insertLine}: "${line}"`);
      break;
    } else {
      // This is a child line
      hasChildren = true;
      lastChildLine = i;
    }
    
    // If we're at the last line and it's still a child, insert after it
    if (i === lines.length - 1) {
      insertLine = i + 2; // Insert after last child (1-based)
      console.log(`Reached end of file with children - inserting after last line at ${insertLine}`);
      break;
    }
  }
  
  // If no children were found, insert right after the current line
  if (!hasChildren) {
    insertLine = cursorLine + 2; // 1-based
    console.log(`No children found - inserting right after current line at ${insertLine}`);
  } else {
    console.log(`Found children ending at line ${lastChildLine + 1} - inserting at ${insertLine}`);
  }
  
  console.log(`Smart insertion line calculated: ${insertLine} (1-based)`);
  return insertLine;
}

/**
 * Create proper groups based on codoc syntax rules
 * Each group should contain items of the same type and context
 */
function createProperGroups(
  processedItems: Array<{
    text: string;
    indentLevel: number;
    path: string[];
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
  }>,
  baseIndent: number = 0,
  existingStructure: any[] = [],
  content: string = '',
  cursorLine: number = 0
): Array<{
  type: string;
  context: string;
  items: Array<{
    text: string;
    indentLevel: number;
    path: string[];
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
  }>;
}> {
  // First, fix indent levels according to codoc rules
  const itemsWithFixedIndents = fixIndentLevels(processedItems, baseIndent, existingStructure, content, cursorLine);

  const groups: Array<{
    type: string;
    context: string;
    items: Array<{
      text: string;
      indentLevel: number;
      path: string[];
      type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
    }>;
  }> = [];

  // Group items by their actual grouping rules - but NEVER mix different types
  const groupMap = new Map<string, Array<typeof itemsWithFixedIndents[0]>>();

  for (const item of itemsWithFixedIndents) {
    // Create a group key that STRICTLY separates different types
    // This ensures %Header, $handleNavigation(), Footer.tsx are in separate groups
    
    let groupKey: string;
    
    if (item.type === 'directory') {
      // Each directory gets its own group unless they are siblings with same parent
      groupKey = `dir_${item.path.join('/')}_${item.indentLevel}`;
    } else if (item.type === 'file') {
      // Each file gets its own group (files should never be grouped with functions/components)
      groupKey = `file_${item.text}_${item.path.join('/')}_${item.indentLevel}`;
    } else if (item.type === 'function') {
      // Functions with same parent file can be grouped, but separate from components
      groupKey = `func_${item.path.join('/')}_${item.indentLevel}`;
    } else if (item.type === 'component') {
      // Components with same parent file can be grouped, but separate from functions
      groupKey = `comp_${item.path.join('/')}_${item.indentLevel}`;
    } else if (item.type === 'variable') {
      // Variables with same parent context can be grouped
      groupKey = `var_${item.path.join('/')}_${item.indentLevel}`;
    } else {
      // References and other types get individual groups
      groupKey = `other_${item.type}_${item.text}_${item.path.join('/')}_${item.indentLevel}`;
    }

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, []);
    }
    groupMap.get(groupKey)!.push(item);
  }

  // Convert map to groups array
  groupMap.forEach((items, groupKey) => {
    const [typePrefix, ...contextParts] = groupKey.split('_');
    const context = contextParts.slice(0, -1).join('_'); // Remove indent level from context
    
    groups.push({
      type: typePrefix,
      context,
      items
    });
  });

  console.log('Created proper groups with fixed indents:', {
    totalItems: processedItems.length,
    totalGroups: groups.length,
    groupDetails: groups.map(g => ({
      type: g.type,
      context: g.context,
      itemCount: g.items.length,
      items: g.items.map(i => `${i.text} (indent: ${i.indentLevel})`)
    }))
  });

  return groups;
}

/**
 * Normalize directory paths in LLM response to ensure consistency
 * Handles cases where directories appear as "components" vs "/components"
 */
function normalizeDirectoryPaths(response: string): string {
  // Split by > to handle hierarchical segments
  const segments = response.split('>');
  
  return segments.map(segment => {
    // Split by ; to handle sibling items
    const items = segment.split(';');
    
    return items.map(item => {
      const trimmed = item.trim();
      
      // Check if this looks like a directory but doesn't start with /
      const commonDirPatterns = /^(src|lib|utils|components|pages|api|hooks|types|styles|assets|public|dist|build|test|tests|spec|docs|config)$/i;
      
      if (commonDirPatterns.test(trimmed) && !trimmed.startsWith('/')) {
        // Add leading slash to make it a proper directory
        return item.replace(trimmed, `/${trimmed}`);
      }
      
      return item;
    }).join(';');
  }).join('>');
}

/**
 * Parse the compact feedforward format into structured suggestions
 * Following @codoc-test/ approach with proper grouping and multi-line display
 */
function parseFeedforwardResponse(
  response: string,
  content: string,
  cursorLine: number,
  parsedSchema: any[]
): FeedforwardSuggestion[] {
  const suggestions: FeedforwardSuggestion[] = [];

  // Clean response - remove any markdown formatting and brackets
  let cleanedResponse = response.trim()
    .replace(/```[a-z]*\n?/g, '') // Remove code blocks
    .replace(/\n```/g, '') // Remove closing code blocks
    .replace(/\[([^\]]+)\]/g, '$1'); // Remove brackets but keep content

  // Normalize directory paths to ensure consistency
  cleanedResponse = normalizeDirectoryPaths(cleanedResponse);

  const lines = cleanedResponse.split('\n').filter(line => line.trim());

  let suggestionId = 0;
  const existingStructure = extractExistingStructure(parsedSchema);

  // Determine base indentation from current context
  const contentLines = content.split('\n');
  const cursorLineContent = contentLines[cursorLine] || '';
  // Fix indent calculation to handle empty lines properly
  const baseIndent = cursorLineContent.trim() === '' 
    ? Math.floor((cursorLineContent.match(/^(\s*)/)?.[1]?.length || 0) / 2)
    : Math.floor(cursorLineContent.search(/\S|$/) / 2);

  for (const line of lines) {
    if (!line.trim()) continue;

    // Parse the compact format: /src>utils.ts>$parseDate();$validateDate();$handleDateFormatting()
    const segments = line.split('>');

    let currentPath: string[] = [];
    let currentIndentLevel = baseIndent;
  // Calculate smart insertion line based on cursor position and content
  // For new suggestions, show at cursor position
  let currentInsertLine = calculateSmartInsertionLine(content, cursorLine, true);

    // CORRECTED FIX: > represents hierarchical nesting, not separate structures
    for (let segmentIdx = 0; segmentIdx < segments.length; segmentIdx++) {
      const segment = segments[segmentIdx].trim();
      if (!segment) continue;

      // Handle items separated by ; (siblings at same level)
      const items = segment.split(';').filter(Boolean);

      // Process each item in this segment
      let processedItems: Array<{
        text: string;
        indentLevel: number;
        path: string[];
        type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
      }> = [];

      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx].trim();
        if (!item) continue;

        let indentLevel = currentIndentLevel;
        let itemPath = [...currentPath];

        if (itemIdx === 0) {
          // First item in segment
          if (item.startsWith('/')) {
            // Directory - check if it's a new root or continuation
            if (segmentIdx === 0) {
              // First segment - root directory
              indentLevel = baseIndent;
              currentPath = [item];
              currentIndentLevel = indentLevel;
              itemPath = [];
            } else {
              // Directory in later segment - could be nested or new root
              // Check if this should be a nested directory under current path
              if (currentPath.length > 0 && currentPath[0].startsWith('/')) {
                // Check if we're currently in a file context - if so, new directory should go to parent
                const hasFile = currentPath.some(p => p.includes('.'));
                if (hasFile) {
                  // We're in a file context, new directory should be sibling to parent directory
                  const rootDir = currentPath.find(p => p.startsWith('/'));
                  if (rootDir) {
                    indentLevel = baseIndent + 1; // Same level as other subdirectories
                    currentPath = [rootDir, item];
                    currentIndentLevel = indentLevel;
                    itemPath = [rootDir];
                    
                    console.log(`🏗️ Sibling directory: ${item}, indent: ${indentLevel}, parent: ${rootDir}`);
                  } else {
                    // Fallback to root level
                    indentLevel = baseIndent;
                    currentPath = [item];
                    currentIndentLevel = indentLevel;
                    itemPath = [];
                  }
                } else {
                  // We're in a directory context, this could be nested
                  indentLevel = currentIndentLevel + 1;
                  currentPath = [...currentPath, item];
                  currentIndentLevel = indentLevel;
                  itemPath = [...currentPath.slice(0, -1)];
                  
                  console.log(`🏗️ Nested directory: ${item}, indent: ${indentLevel}, parent: ${currentPath.slice(0, -1).join('/')}`);
                }
              } else {
                // New root directory
                indentLevel = baseIndent;
                currentPath = [item];
                currentIndentLevel = indentLevel;
                itemPath = [];
                
                console.log(`🏗️ Root directory: ${item}, indent: ${indentLevel}`);
              }
            }
            
            console.log(`🏗️ Directory: ${item}, indent: ${indentLevel}, segment: ${segmentIdx}`);
          } else if (!item.startsWith('$') && !item.startsWith('%') && !item.startsWith('@')) {
            // Check if this is actually a directory (even without /)
            const itemType = analyzeSuggestionType(item);
            if (itemType.type === 'directory') {
              // It's a directory - handle like other directories
              indentLevel = currentIndentLevel + 1;
              currentPath = [...currentPath, item];
              currentIndentLevel = indentLevel;
              itemPath = [...currentPath.slice(0, -1)];
              
              console.log(`🏗️ Directory (no slash): ${item}, indent: ${indentLevel}, parent: ${itemPath.join('/')}`);
            } else if (itemType.type === 'file') {
              // It's a file - check if it should be at same level as previous file
              const parentDir = currentPath.find(p => p.startsWith('/'));
              if (parentDir && currentPath.length >= 2) {
                // We have a parent directory and we're potentially nested too deep
                // Check if this file should be a sibling to the previous file
                const previousFileIndex = currentPath.findIndex(p => p.includes('.'));
                if (previousFileIndex !== -1) {
                  // There's a previous file, this new file should be at same level
                  currentPath = [parentDir, item]; // Reset to parent dir + new file
                  indentLevel = baseIndent + 1; // Same level as other files under this directory
                  currentIndentLevel = indentLevel;
                  itemPath = [parentDir];
                  
                  console.log(`📄 File (sibling): ${item}, indent: ${indentLevel}, parent: ${parentDir}`);
                } else {
                  // Normal nesting
                  indentLevel = currentIndentLevel + 1;
                  currentPath = [...currentPath, item];
                  currentIndentLevel = indentLevel;
                  itemPath = [...currentPath.slice(0, -1)];
                }
              } else {
                // Normal file processing
                indentLevel = currentIndentLevel + 1;
                currentPath = [...currentPath, item];
                currentIndentLevel = indentLevel;
                itemPath = [...currentPath.slice(0, -1)];
              }
            } else {
              // Variable or other type
              indentLevel = currentIndentLevel + 1;
              itemPath = [...currentPath];
            }
          } else {
            // It's a function/component - belongs to current path
            indentLevel = currentIndentLevel + 1;
            itemPath = [...currentPath];
          }
        } else {
          // Subsequent items in segment - siblings at same level as first item
          const firstItem = items[0];
          
          if (firstItem.startsWith('/')) {
            // First item was a directory, so subsequent items are nested under it
            indentLevel = currentIndentLevel + 1;
            itemPath = [...currentPath.slice(0, -1)];
          } else {
            // First item was a file/function/component, so siblings are at same level
            // All items separated by ; should have the SAME indent level
            indentLevel = currentIndentLevel + 1;
            itemPath = [...currentPath];
          }
        }

        // Add to processed items
        processedItems.push({
          text: item,
          indentLevel,
          path: itemPath,
          type: analyzeSuggestionType(item).type
        });
      }

      // Group items properly by type and context
      const properGroups = createProperGroups(processedItems, baseIndent, existingStructure, content, cursorLine);

      // Create suggestions for each proper group
      for (const group of properGroups) {
        const groupId = `group_${suggestionId}`;
        const groupItems = group.items.map(item => item.text);

        console.log('Creating proper group suggestion:', { 
          groupId, 
          groupItems,
          count: groupItems.length,
          type: group.type,
          context: group.context
        });

        // Create a suggestion for this group
        const firstItem = group.items[0];
        suggestions.push(createSuggestion(
          firstItem.text,
          currentInsertLine,
          firstItem.indentLevel,
          suggestionId++,
          firstItem.path,
          groupId,
          groupItems
        ));
        // Don't increment currentInsertLine for grouped items - they should all appear at the same position
      }
    }
  }

  return suggestions;
}

// Removed determineFolderPosition function as it's no longer needed with the new indent logic

function createSuggestion(
  text: string,
  line: number,
  indent: number,
  id: number,
  path: string[],
  groupId?: string,
  groupItems?: string[]
): FeedforwardSuggestion {
  const type = analyzeSuggestionType(text).type;

  // Construct fullPath correctly based on type
  let fullPath: string;
  if (type === 'directory') {
    // For directories, the path represents the parent path
    fullPath = [...path, text].join('/').replace(/\/+/g, '/');
  } else if (type === 'file') {
    // For files, the path represents the parent directory
    fullPath = [...path, text].join('/').replace(/\/+/g, '/');
  } else {
    // For functions, components, variables, references - they belong to the current file/directory
    // Don't add the item itself to the path, it belongs to the path
    fullPath = path.join('/').replace(/\/+/g, '/') + (path.length > 0 ? '/' : '') + text;
  }

  // Clean up the path
  if (fullPath.startsWith('//')) {
    fullPath = fullPath.substring(1);
  }
  console.log('Creating suggestion object:', {
    text,
    insertLine: line,
    indentLevel: indent,
    type,
    position: `line_${line}`,
    id: `feedforward_${Date.now()}_${id}`,
    fullPath,
    parent: path[path.length - 1],
    groupId,
    groupItems,
    sequence: id
  });
  return {
    text,
    insertLine: line,
    indentLevel: indent,
    type,
    position: `line_${line}`,
    id: `feedforward_${Date.now()}_${id}`,
    fullPath,
    parent: path[path.length - 1],
    groupId,
    groupItems,
    sequence: id
  };
}

/**
 * Generate feedforward suggestions with improved prompt
 */
export async function generateFeedforwardSuggestions(
  content: string,
  cursorLine: number,
  cursorPos: number,
  parsedSchema: any[],
  codebase: any[],
  rejectedPatterns?: Set<string>
): Promise<FeedforwardResult> {

  try {
    const lines = content.split('\n');
    const context = getContextAroundCursor(lines, cursorLine, 5);

    const prompt = createFeedforwardPrompt(
      content,
      cursorLine,
      context,
      parsedSchema,
      codebase,
      rejectedPatterns
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    let responseContent = completion.choices[0].message.content;
    if (!responseContent) {
      throw new Error('No response from OpenAI');
    }
    responseContent = responseContent.replace(/```json\n/, '').replace(/\n```/, '');
    responseContent = responseContent.replace(/```\n/, '').replace(/\n```/, '');


    const suggestions = parseFeedforwardResponse(responseContent, content, cursorLine, parsedSchema);

    const filtered = filterDuplicateSuggestions(suggestions, parsedSchema, codebase, content);

    const merged = mergeWithExistingStructure(filtered, parsedSchema, cursorLine);

    console.log('FEEDFORWARD SUGGESTIONS:', suggestions, filtered, merged);
    return { suggestions: merged };
  } catch (error) {
    console.error('❌ Feedforward generation error:', error);

    // // Fallback to basic suggestions when API fails
    // const fallbackSuggestions = generateFallbackSuggestions(content, cursorLine, cursorPos, rejectedPatterns);
    // return fallbackSuggestions;
  }
}


/**
 * Prompt for feedforward suggestions
 */
function createFeedforwardPrompt(
  content: string,
  cursorLine: number,
  context: any,
  parsedSchema: any[],
  codebase: any[],
  rejectedPatterns?: Set<string>
) {
  const systemPrompt = `You are an expert software architect providing intelligent feedforward suggestions for a CoDoc system using the Codoc syntax.

CODOC SYNTAX:
/directory - Folders
file.ext - Files  
%Component - React components
$function() - Functions
@reference - Links

OUTPUT FORMAT:
Use compact notation with > for nesting and ; for multiple items at same level:

EXAMPLES:
1. Authentication feature:
/auth>login.ts>$authenticateUser();$validateCredentials();$handleLogin()auth.types.ts>UserRole;AuthState
/components>LoginForm.tsx>%LoginForm;$handleSubmit();RegisterForm.tsx>%RegisterForm;$handleRegister()

----FIRST EXAMPLE----
/auth
  login.ts
    $authenticateUser()
    $validateCredentials()
    $handleLogin()
  auth.types.ts
    UserRole
    AuthState
/components
  LoginForm.tsx
    %LoginForm
    $handleSubmit()
  RegisterForm.tsx
    %RegisterForm
    $handleRegister()
----FIRST EXAMPLE----

2. API and utilities:
/api>users.ts>$fetchUser();$updateUser();$handleUserUpdate();posts.ts>$createPost();$deletePost();$handlePostDelete()
/utils>validation.ts>$validateEmail();$validatePassword();$handleValidation();helpers.ts>$formatDate();$sanitizeInput();$handleSanitization()

----SECOND EXAMPLE----
/api
  users.ts
    $fetchUser()
    $updateUser()
    $handleUserUpdate()
  posts.ts
    $createPost()
    $deletePost()
    $handlePostDelete()
/utils
  validation.ts
    $validateEmail()
    $validatePassword()
    $handleValidation()
  helpers.ts
    $formatDate()
    $sanitizeInput()
    $handleSanitization()
----SECOND EXAMPLE----

3. Component with hooks:
/components>UserProfile.tsx>%UserProfile;$useUserData();/hooks>useAuth.ts>$useAuth();$usePermissions()

----THIRD EXAMPLE----
/components
  UserProfile.tsx
    %UserProfile
    $useUserData()
    /hooks
      useAuth.ts
        $useAuth()
        $usePermissions()
----THIRD EXAMPLE----

4. Web Scraper:
/src>/test>scraper.ts>$scrapeWebsite();$parseHtml();scrapedResult.tsx>$handleResult();$displayResult();@ScrapedResult;/types>scraper.types.ts

----FOURTH EXAMPLE----
/src
  /test
    scraper.ts
      $scrapeWebsite()
      $parseHtml()
      $handleResult()
      $displayResult()
      @ScrapedResult
      /types
        scraper.types.ts

----FOURTH EXAMPLE----

5. Weather Dashboard:
/components>WeatherDashboard.tsx>%WeatherDashboard;$useWeatherData();/hooks>useWeather.ts>$useWeather();$useLocation()
/utils>weather.ts>$fetchWeather();$formatWeather();/types>weather.types.ts

----FIFTH EXAMPLE----
/components
  WeatherDashboard.tsx
    %WeatherDashboard
    $useWeatherData()
    /hooks
      useWeather.ts
        $useWeather()
        $useLocation()
/utils
  weather.ts
    $fetchWeather()
    $formatWeather()
  /types
    weather.types.ts
----FIFTH EXAMPLE----


CRITICAL RULES:
1. Suggest 2-4 PRACTICAL additions that complete the current structure
2. Focus on what's the most important and missing for a working application
3. Consider software engineering best practices
4. Use > for hierarchy (folder>file>function|component), ; for siblings at same level
5. Keep suggestions realistic and implementable
6. Group logically related items in same output line
7. if a new file or folder should be created, you should start with the existing folder name to indicate the position of the new file or folder

AVOID:
- Already existing elements (you can only mention about the existing elements for indicating the path)
- Overly generic suggestions
- Unrelated additions
- Suggesting directories, files, or functions that already exist in the current structure
- Duplicating any existing elements

${rejectedPatterns?.size ? `- Previously rejected patterns: ${Array.from(rejectedPatterns).join(', ')}` : ''}

Think like a senior engineer: What's the next logical piece to build this feature?`;

  const userPrompt = `
current whole codoc structure:
${content}
  
cursor position:
\`\`\`
${context.beforeCursor.join('\n')}
→ ${context.currentLine} [CURSOR HERE]
${context.afterCursor.join('\n')}
\`\`\`

Context: ${context.currentContext}
Current indent: ${context.currentLineIndent}

What practical additions would complete this feature? Output in compact format.
IMPORTANT: Do NOT suggest any directories, files, or functions that already exist in the current structure above.
DO NOT INCLUDE ANYTHING ELSE IN YOUR RESPONSE, NO EXPLANATION, NO COMMENTS, NO THOUGHTS, NO MARKDOWN, NO NOTHING.
`;

  return { systemPrompt, userPrompt };
}

/**
 * Get enhanced context around cursor
 */
function getContextAroundCursor(lines: string[], cursorLine: number, contextSize: number) {
  const start = Math.max(0, cursorLine - contextSize);
  const end = Math.min(lines.length, cursorLine + contextSize + 1);

  const beforeCursor = lines.slice(start, cursorLine);
  const afterCursor = lines.slice(cursorLine + 1, end);
  const currentLine = lines[cursorLine] || '';

  const currentLineIndent = currentLine.search(/\S|$/);

  // Determine current context more intelligently
  let currentContext = 'root';
  let contextPath = [];
  let lastDirectory = '';
  let lastFile = '';

  for (let i = cursorLine; i >= 0; i--) {
    const line = lines[i];
    const lineIndent = line.search(/\S|$/);
    const trimmed = line.trim();

    if (lineIndent < currentLineIndent || i === cursorLine) {
      if (trimmed.startsWith('/')) {
        lastDirectory = trimmed.slice(1);
        contextPath.unshift(trimmed.slice(1));
      } else if (trimmed.includes('.') && !trimmed.startsWith('%') && !trimmed.startsWith('$')) {
        lastFile = trimmed;
        contextPath.push(trimmed);
        break;
      }
    }
  }

  currentContext = contextPath.length > 0 ? contextPath.join('/') : 'root';

  return {
    beforeCursor,
    afterCursor,
    currentLine,
    currentLineIndent,
    currentContext,
    lastDirectory,
    lastFile
  };
}

/**
 * Filter duplicate suggestions
 */
function filterDuplicateSuggestions(
  suggestions: FeedforwardSuggestion[],
  parsedSchema: any[],
  codebase: any[],
  content: string
): FeedforwardSuggestion[] {
  const existingElements = new Set<string>();

  // Extract existing elements from schema
  const extractFromSchema = (nodes: any[]) => {
    for (const node of nodes) {
      const nodeText = node.type === 'function' ? `$${node.name}()` :
        node.type === 'component' ? `%${node.name}` :
            node.type === 'file' ? `${node.name}${node.extension || ''}` :
              node.type === 'directory' ? `/${node.name}` :
                node.name;
      existingElements.add(nodeText);

      if (node.children) {
        extractFromSchema(node.children);
      }
    }
  };

  extractFromSchema(parsedSchema);

  // Also extract existing elements from the actual CoDoc content
  const extractFromContent = (content: string) => {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        existingElements.add(trimmed);

        // Also add common variations
        if (trimmed.startsWith('/')) {
          existingElements.add(trimmed); // Directory
        } else if (trimmed.includes('.')) {
          existingElements.add(trimmed); // File
        } else if (trimmed.startsWith('$')) {
          existingElements.add(trimmed); // Function
        } else if (trimmed.startsWith('%')) {
          existingElements.add(trimmed); // Component
        }
      }
    }
  };

  extractFromContent(content);


  return suggestions.filter(s => {
    const suggestionText = s.text.trim();
    
    // Check for exact matches first
    if (existingElements.has(suggestionText)) {
      return false;
    }
    
    // 🔥 @codoc-test 的精确重复检测逻辑
    // Check for directory/file duplicates more precisely
    if (suggestionText.startsWith('/')) {
      // For directories, check if the directory name already exists
      const dirName = suggestionText.substring(1); // Remove leading /
      const hasDir = Array.from(existingElements).some(existing => 
        existing === suggestionText || 
        existing.startsWith('/' + dirName + '/') ||
        existing === dirName
      );
      if (hasDir) {
        return false;
      }
    } else if (suggestionText.includes('.')) {
      // For files, check if the file already exists
      const hasFile = Array.from(existingElements).some(existing => 
        existing === suggestionText || 
        existing.endsWith(suggestionText)
      );
      if (hasFile) {
        return false;
      }
    } else if (suggestionText.startsWith('$') || suggestionText.startsWith('%')) {
      // For functions/components, check if they already exist
      const hasFunction = Array.from(existingElements).some(existing => 
        existing === suggestionText
      );
      if (hasFunction) {
        return false;
      }
    }
    
    return true;
  });
}

/**
 * Extract existing structure from parsed schema
 */
function extractExistingStructure(parsedSchema: any[]): Array<{
  text: string;
  type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
  indentLevel: number;
  lineNumber: number;
  node: any;
}> {
  const structure: Array<{
    text: string;
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
    indentLevel: number;
    lineNumber: number;
    node: any;
  }> = [];
  
  // Recursively extract nodes with their hierarchical information
  const extractNodes = (nodes: any[], indentLevel: number = 0, lineCounter: { value: number } = { value: 0 }) => {
    for (const node of nodes) {
      const text = node.type === 'directory' ? `/${node.name}` :
                  node.type === 'file' ? `${node.name}${node.extension || ''}` :
                  node.type === 'component' ? `%${node.name}` :
                  node.type === 'function' ? `$${node.name}()` :
                  node.type === 'variable' ? node.name :
                  node.type === 'reference' ? `@${node.name}` :
                  node.name;
      
      structure.push({
        text,
        type: node.type as any,
        indentLevel,
        lineNumber: lineCounter.value++,
        node
      });
      
      if (node.children && node.children.length > 0) {
        extractNodes(node.children, indentLevel + 1, lineCounter);
      }
    }
  };
  
  extractNodes(parsedSchema);
  return structure;
}

/**
 * Find the best insertion point within an existing directory
 */
function findInsertionPointInExistingDirectory(
  existingDir: {
    text: string;
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
    indentLevel: number;
    lineNumber: number;
    node: any;
  },
  suggestion: FeedforwardSuggestion,
  existingStructure: Array<{
    text: string;
    type: 'directory' | 'file' | 'function' | 'component' | 'variable' | 'reference';
    indentLevel: number;
    lineNumber: number;
    node: any;
  }>
): { insertLine: number; indentLevel: number } {
  const targetIndent = existingDir.indentLevel + 1;
  
  // Find all items under this directory
  const directoryItems = existingStructure.filter(item => 
    item.lineNumber > existingDir.lineNumber && 
    item.indentLevel > existingDir.indentLevel
  );
  
  if (directoryItems.length === 0) {
    // Empty directory, insert right after it
    return {
      insertLine: existingDir.lineNumber + 1,
      indentLevel: targetIndent
    };
  }
  
  // Find items at the same level within the directory
  const sameTypeItems = directoryItems.filter(item => 
    item.indentLevel === targetIndent && 
    item.type === suggestion.type
  );
  
  if (sameTypeItems.length === 0) {
    // No items of same type, find appropriate insertion point
    if (suggestion.type === 'file') {
      // Files typically come first
      const firstNonFile = directoryItems.find(item => 
        item.indentLevel === targetIndent && item.type !== 'file'
      );
      return {
        insertLine: firstNonFile ? firstNonFile.lineNumber : directoryItems[directoryItems.length - 1].lineNumber + 1,
        indentLevel: targetIndent
      };
    } else {
      // Functions/components typically come after files
      return {
        insertLine: directoryItems[directoryItems.length - 1].lineNumber + 1,
        indentLevel: targetIndent
      };
    }
  }
  
  // Items of same type exist, insert alphabetically
  const insertionPoint = sameTypeItems.find(item => item.text > suggestion.text);
  return {
    insertLine: insertionPoint ? insertionPoint.lineNumber : sameTypeItems[sameTypeItems.length - 1].lineNumber + 1,
    indentLevel: targetIndent
  };
}

/**
 * Merge suggestions with existing structure
 */
function mergeWithExistingStructure(
  suggestions: FeedforwardSuggestion[],
  parsedSchema: any[],
  cursorLine: number
): FeedforwardSuggestion[] {
  if (suggestions.length === 0) return suggestions;

  const existingStructure = extractExistingStructure(parsedSchema);
  const mergedSuggestions: FeedforwardSuggestion[] = [];
  
  // Process each suggestion to check if it should merge with existing or be new
  for (const suggestion of suggestions) {
    // Check if this exact item already exists
    const existingItem = existingStructure.find(item => 
      item.text === suggestion.text && item.type === suggestion.type
    );
    
    if (existingItem) {
      // Item already exists - skip it
      continue;
    }
    
    // Check if we need to merge into an existing directory structure
    if (suggestion.type === 'directory') {
      // This is a new directory
      mergedSuggestions.push(suggestion);
    } else {
      // This is a file/function/component - check if its parent directory exists
      const parentPath = suggestion.fullPath.split('/').slice(0, -1).join('/') || '/';
      const existingParentDir = existingStructure.find(item => 
        item.type === 'directory' && (item.text === parentPath || item.node.path === parentPath)
      );
      
      if (existingParentDir) {
        // Parent directory exists - adjust position to insert under it
        const insertionPoint = findInsertionPointInExistingDirectory(
          existingParentDir,
          suggestion,
          existingStructure
        );
        
        mergedSuggestions.push({
          ...suggestion,
          insertLine: insertionPoint.insertLine,
          indentLevel: insertionPoint.indentLevel
        });
      } else {
        // Parent directory doesn't exist or this is at root level
        mergedSuggestions.push(suggestion);
      }
    }
  }
  
  // Sort by insertion line to maintain order
  return mergedSuggestions.sort((a, b) => a.insertLine - b.insertLine);
}

// Removed extractParentPaths - no longer needed with new batch insertion approach

// Removed findGroupByPath - no longer needed with new batch insertion approach

// Removed pathMatches and sortByPathDepth - no longer needed with new batch insertion approach

// Removed findDependentSuggestions - no longer needed with new batch insertion approach

// Removed organizeByGroups - no longer needed with new batch insertion approach

// Removed shouldSuggestionComeBefore - no longer needed with new batch insertion approach

// Removed isParentOf - no longer needed for bottom-up insertion

// Removed calculateDynamicInsertionLine - no longer needed with new batch insertion approach

// Removed acceptSuggestionsInSequence - no longer needed with new batch insertion approach

// Helper function for dynamic line calculation
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
 * Analyze suggestion type
 */
function analyzeSuggestionType(text: string): {
  type: 'component' | 'function' | 'variable' | 'file' | 'directory' | 'reference';
} {
  if (text.startsWith('/')) return { type: 'directory' };
  if (text.startsWith('%')) return { type: 'component' };
  if (text.startsWith('$')) return { type: 'function' };
  if (text.startsWith('@')) return { type: 'reference' };
  if (text.includes('.')) return { type: 'file' };
  
  // Check if it's likely a directory name (common directory patterns)
  const commonDirPatterns = /^(src|lib|utils|components|pages|api|hooks|types|styles|assets|public|dist|build|test|tests|spec|docs|config)$/i;
  if (commonDirPatterns.test(text)) {
    return { type: 'directory' };
  }
  
  return { type: 'variable' };
}

/**
 * Format suggestion for insertion
 */
function formatSuggestionText(suggestion: FeedforwardSuggestion): string {
  // Use proper spacing for indent (2 spaces per level)
  const indent = '  '.repeat(Math.max(0, suggestion.indentLevel));
  
  // If this is a grouped suggestion, format all items in the group
  if (suggestion.groupItems && suggestion.groupItems.length > 1) {
    return '\n' + suggestion.groupItems.map(item => {
      const itemTrimmed = item.trim();
      return indent + itemTrimmed;
    }).join('\n');
  }
  
  return '\n' + indent + suggestion.text.trim();
}


// Enhanced plugin with Alt+Arrow navigation from @codoc-test/
const feedforwardPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    ctrlShiftPressed = false;
    handleKeyDown?: (e: KeyboardEvent) => void;
    handleKeyUp?: (e: KeyboardEvent) => void;

    constructor(view: EditorView) {
      this.decorations = Decoration.none;
      this.setupEventListeners(view);
    }

    setupEventListeners(view: EditorView) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (this.ctrlShiftPressed) {
          e.preventDefault()
        }
        if (e.altKey && !this.ctrlShiftPressed) {
          e.preventDefault();
          this.ctrlShiftPressed = true;
          this.updateHighlight(view);
        } else if (this.ctrlShiftPressed && e.key === 'Tab') {
          e.preventDefault();
          const state = view.state.field(feedforwardState);

          if (!state.highlightedSuggestion) return false;

          const suggestion = state.suggestions.find(s => s.id === state.highlightedSuggestion);
          if (!suggestion) return false;

          // Just mark the suggestion as accepted (visual feedback only)
          console.log('Marking suggestion as accepted (visual only):', suggestion.text);

            view.dispatch({
            effects: [acceptSuggestionEffect.of(suggestion.id)]
          });

          // Move to next unaccepted suggestion
          this.updateHighlight(view);
          return true;
        } else if (this.ctrlShiftPressed && e.key === 'ArrowRight') {
          e.preventDefault();
          const state = view.state.field(feedforwardState);

          if (!state.isNavigating || state.suggestions.length === 0) return false;

          // Navigate to next unaccepted suggestion
          const availableSuggestions = state.suggestions.filter(s => !state.acceptedSuggestions.has(s.id));
          if (availableSuggestions.length === 0) return false;

          const currentIndex = state.highlightedSuggestion ?
            availableSuggestions.findIndex(s => s.id === state.highlightedSuggestion) : -1;

          const nextIndex = (currentIndex + 1) % availableSuggestions.length;
          const nextSuggestion = availableSuggestions[nextIndex];

          if (nextSuggestion) {
            // Clear current decorations before highlighting new suggestion to avoid range conflicts
            view.dispatch({
              effects: highlightSuggestionEffect.of(null)
            });
            
            // Add slight delay to avoid range conflicts when decorations are being updated
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
          
          // If there are accepted suggestions, insert them all at once
          if (state.acceptedSuggestions.size > 0) {
            console.log('Alt key released - inserting all accepted suggestions');
            this.insertAllAcceptedSuggestions(view, state);
          } else if (state.isNavigating) {
            // No accepted suggestions, just clear
            view.dispatch({
              effects: clearFeedforwardEffect.of()
            });
          }
        }
      };

      // Store references for cleanup
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

    calculateInsertionPosition(state: EditorState, suggestion: FeedforwardSuggestion): { from: number; to: number } {
      const doc = state.doc;
      const targetLine = Math.min(Math.max(suggestion.insertLine, 1), doc.lines);
      const line = doc.line(targetLine);
      const lineText = line.text;

      // Smart insertion: detect and handle prefixes to avoid duplication
      let insertFrom = line.to;
      let insertTo = line.to;

      // Check for trailing prefixes that match suggestion start
      if (suggestion.type === 'directory' && suggestion.text.startsWith('/')) {
        // For directories like "/components", check if line ends with "/" (ignoring whitespace)
        const trimmedText = lineText.trimEnd();
        if (trimmedText.endsWith('/')) {
          // Find the position of the last "/" to replace from there
          const lastSlashIndex = lineText.lastIndexOf('/');
          if (lastSlashIndex !== -1) {
            insertFrom = line.from + lastSlashIndex;
            insertTo = line.from + trimmedText.length; // Only replace up to trimmed end
          }
        }
      } else if (suggestion.type === 'function' && suggestion.text.startsWith('$')) {
        // For functions like "$handleSubmit()", check if line ends with "$" or multiple "$" symbols
        const trimmedText = lineText.trimEnd();
        if (trimmedText.endsWith('$') || /\$+$/.test(trimmedText)) {
          // Find all consecutive $ symbols at the end
          const match = trimmedText.match(/\$+$/);
          if (match) {
            const dollarStartIndex = trimmedText.length - match[0].length;
            insertFrom = line.from + dollarStartIndex;
            insertTo = line.from + trimmedText.length; // Only replace up to trimmed end
          }
        }
      }

      return { from: insertFrom, to: insertTo };
    }


    insertAllAcceptedSuggestions(view: EditorView, state: any) {
      // Get all accepted suggestions
      const acceptedSuggestions = state.suggestions.filter((s: FeedforwardSuggestion) => state.acceptedSuggestions.has(s.id));

      if (acceptedSuggestions.length === 0) return;

      console.log('Inserting accepted suggestions (bottom-up at own positions):', acceptedSuggestions.map((s: FeedforwardSuggestion) => `${s.text} @${s.insertLine}`));

      // Sort bottom-up by insertion line to avoid position shifting.
      // For ties on the same line: insert in REVERSE LLM order (sequence descending)
      // so that the final rendered order matches the original LLM order.
      // This accounts for CodeMirror inserting later changes before earlier ones at the same position.
      const bottomUp = [...acceptedSuggestions].sort((a, b) => {
        if (a.insertLine !== b.insertLine) return b.insertLine - a.insertLine; // later lines first
        const aSeq = a.sequence ?? 0;
        const bSeq = b.sequence ?? 0;
        if (aSeq !== bSeq) return bSeq - aSeq; // later LLM items first
        return b.indentLevel - a.indentLevel; // deeper first within same sequence as extra tie-breaker
      });

      let lastSelectionPos: number | null = null;

      for (const suggestion of bottomUp) {
        const insertPos = calculateInsertionPositionForDynamicLine(view.state, suggestion.insertLine);
        const insertText = formatSuggestionText(suggestion);

        // Insert this suggestion at its own calculated line
        view.dispatch({
          changes: { from: insertPos, to: insertPos, insert: insertText },
          annotations: [feedforwardAcceptAnnotation.of(true)]
        });

        const endPos = insertPos + insertText.length;
        lastSelectionPos = lastSelectionPos === null ? endPos : Math.max(lastSelectionPos, endPos);
      }

      // After all insertions, clear the overlay and place cursor at the end of the last inserted block
      if (lastSelectionPos !== null) {
        view.dispatch({
          selection: EditorSelection.cursor(lastSelectionPos),
          effects: [clearFeedforwardEffect.of()]
        });
      } else {
        view.dispatch({ effects: [clearFeedforwardEffect.of()] });
      }

      console.log('All accepted suggestions inserted bottom-up successfully');
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
      const state = update.state.field(feedforwardState);

      if (state.suggestions.length === 0) {
        this.decorations = Decoration.none;
        return;
      }

      const decorationData: Array<{decoration: any, position: number}> = [];

      for (const suggestion of state.suggestions) {
        const isAccepted = state.acceptedSuggestions.has(suggestion.id);
        const isHighlighted = state.highlightedSuggestion === suggestion.id;
        
        // Show accepted suggestions in green, unaccepted in blue/gray, hide if not navigating
        const isVisible = !state.isNavigating || isHighlighted || this.ctrlShiftPressed || isAccepted;

        const doc = update.state.doc;
        
        // Calculate insertion line for decoration display
        let targetLine: number = this.calculateInsertionLineForDecoration(
          suggestion, 
          state, 
          doc,
          update.view
        );
        
        targetLine = Math.min(Math.max(targetLine, 1), doc.lines);
        const line = doc.line(targetLine);

        const widget = new FeedforwardLineWidget(suggestion, isHighlighted, isAccepted, isVisible);
        const decoration = Decoration.widget({
          widget,
          side: 1
        });

        // Store decoration with its position for sorting
        decorationData.push({
          decoration: decoration.range(line.to),
          position: line.to
        });
      }

      // Sort decorations by position to avoid CodeMirror range errors
      decorationData.sort((a, b) => a.position - b.position);
      const sortedDecorations = decorationData.map(item => item.decoration);

      this.decorations = Decoration.set(sortedDecorations);
    }

    // Method to calculate insertion line for decorations
    calculateInsertionLineForDecoration(
      suggestion: FeedforwardSuggestion,
      state: any,
      doc: any,
      view: EditorView
    ): number {
      // With the new approach, always show suggestions at their original positions
      // This keeps the visual structure stable while users are making selections
      console.log(`Showing suggestion "${suggestion.text}" at original position:`, suggestion.insertLine);
        return suggestion.insertLine;
    }

    destroy() {
      // Cleanup event listeners
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

// 移除旧的 debounce 函数 - 现在使用 CodeMirrorEditor.tsx 中的触发逻辑

/**
 * Feedforward extension for CodeMirror
 */
export function feedforwardExtension() {
  return [
    feedforwardState,
    feedforwardPlugin,
  ];
}

/**
 * Add feedforward suggestions to editor
 */
export function addFeedforwardSuggestions(view: EditorView, suggestions: FeedforwardSuggestion[]) {
  view.dispatch({
    effects: addFeedforwardEffect.of({
      suggestions,
      doc: view.state.doc
    })
  });
}

/**
 * Clear feedforward suggestions
 */
export function clearFeedforwardSuggestions(view: EditorView) {
  view.dispatch({
    effects: clearFeedforwardEffect.of()
  });
}

/**
 * Get feedforward state from editor view
 */
export function getFeedforwardState(view: EditorView) {
  try {
    return view.state.field(feedforwardState);
  } catch (e) {
    return null;
  }
}

/**
 * Set pending feedforward request - tracks position where request was initiated
 */
export function setPendingFeedforwardRequest(
  view: EditorView, 
  cursorLine: number, 
  cursorColumn: number, 
  content: string
) {
  view.dispatch({
    effects: setPendingRequestEffect.of({
      cursorLine,
      cursorColumn,
      requestTime: Date.now(),
      content
    })
  });
}

/**
 * Set editor focus state
 */
export function setEditorFocusState(view: EditorView, isFocused: boolean) {
  view.dispatch({
    effects: setFocusStateEffect.of(isFocused)
  });
}


/**
 * Check if feedforward should be triggered at current position
 */
export function shouldTriggerFeedforward(view: EditorView): boolean {
  const state = getFeedforwardState(view);
  if (!state) return false;

  // Don't trigger if not focused
  if (!state.isEditorFocused) {
    console.log('Not triggering feedforward - editor not focused');
    return false;
  }

  // Don't trigger if already navigating
  if (state.isNavigating) {
    console.log('Not triggering feedforward - currently navigating');
    return false;
  }

  // Don't trigger if there's a pending request
  if (state.pendingRequest) {
    console.log('Not triggering feedforward - request already pending');
    return false;
  }

  // Don't trigger if there are unaccepted suggestions
  const hasUnacceptedSuggestions = state.suggestions.some(s => !state.acceptedSuggestions.has(s.id));
  if (hasUnacceptedSuggestions) {
    console.log('Not triggering feedforward - has unaccepted suggestions');
    return false;
  }

  return true;
}
