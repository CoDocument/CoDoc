/**
 * Activity Event Types for OpenCode SDK
 * These are the key events we track and surface to the user
 */

import { FileDiff } from '../../types.js';

// ============================================
// KEY ACTIVITY EVENTS - surfaced to UI
// ============================================

export type ActivityEventType = 
  | 'thinking'      // AI reasoning/text streaming
  | 'reading'       // Reading file (tool: read)
  | 'editing'       // Editing file (tool: edit)
  | 'creating'      // Creating new file
  | 'diff'          // Session diff with file changes
  | 'summary'       // Final message summary
  | 'complete'      // Session complete
  | 'error';        // Error occurred

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  
  // Display info
  message: string;
  details?: string;
  
  // For file operations
  filePath?: string;
  fileName?: string;
  componentName?: string;
  
  // For diffs
  additions?: number;
  deletions?: number;
  
  // For tool operations
  toolName?: string;
  toolStatus?: 'pending' | 'running' | 'completed' | 'error';
  
  // Raw data for advanced use
  raw?: any;
}

// ============================================
// GUTTER DECORATION DATA
// ============================================

export type GutterIconType = 
  | 'read'      // 👀 Eye icon - file was read
  | 'edit'      // ✎ Pencil icon - file/component was edited
  | 'create'    // + Plus icon - new file/component created
  | 'delete';   // ⌫ Delete icon - something was removed

export interface GutterDecoration {
  id: string;
  lineNumber: number;
  iconType: GutterIconType;
  tooltip: string;
  filePath?: string;
  componentName?: string;
  
  // Stats for edits
  additions?: number;
  deletions?: number;
}

// ============================================
// PARSED EVENT DATA
// ============================================

export interface ParsedEditEvent {
  filePath: string;
  fileName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  additions?: number;
  deletions?: number;
  diff?: string;
  title?: string;
}

export interface ParsedReadEvent {
  filePath: string;
  fileName: string;
  status: 'pending' | 'running' | 'completed';
  lineCount?: number;
}

export interface ParsedDiffEvent {
  sessionId: string;
  files: Array<{
    file: string;
    fileName: string;
    additions: number;
    deletions: number;
  }>;
  totalAdditions: number;
  totalDeletions: number;
}

export interface ParsedSummaryEvent {
  messageId: string;
  sessionId: string;
  title?: string;
  body?: string;
  diffs: FileDiff[];
  model: {
    providerId: string;
    modelId: string;
  };
}

export interface ParsedThinkingEvent {
  messageId: string;
  text: string;
  isComplete: boolean;
}

// ============================================
// EVENT CALLBACKS
// ============================================

export interface ActivityEventCallbacks {
  onActivity: (event: ActivityEvent) => void;
  onGutterDecoration: (decoration: GutterDecoration) => void;
  onSummary: (summary: ParsedSummaryEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract filename from a full file path
 */
export function extractFileName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Create a concise activity message for display
 */
export function createActivityMessage(type: ActivityEventType, details: any): string {
  switch (type) {
    case 'thinking':
      return `Thinking: ${truncateText(details.text || '...', 50)}`;
    case 'reading':
      return `Reading ${extractFileName(details.filePath || 'file')}...`;
    case 'editing':
      return `Editing ${extractFileName(details.filePath || 'file')}`;
    case 'creating':
      return `Creating ${extractFileName(details.filePath || 'file')}`;
    case 'diff':
      return `${details.totalAdditions || 0}+ ${details.totalDeletions || 0}- in ${details.fileCount || 0} files`;
    case 'summary':
      return details.title || 'Generation complete';
    case 'complete':
      return 'Complete';
    case 'error':
      return `Error: ${truncateText(details.message || 'Unknown error', 50)}`;
    default:
      return 'Processing...';
  }
}

/**
 * Truncate text to a maximum length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Generate unique ID for events
 */
export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
