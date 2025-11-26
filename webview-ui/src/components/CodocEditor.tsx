/**
 * Main CoDoc Editor Component
 * Using @uiw/react-codemirror wrapper for better React integration
 * 
 * ARCHITECTURE CONNECTIONS:
 * 
 * Backend Services → Frontend Extensions:
 * 
 * 1. StructuralDiffEngine → feedbackDecorationExtension
 *    - StructuralDiffEngine.compare() analyzes old vs new CoDoc structure
 *    - CodeChangeAnalyzer wraps the diff engine and converts to CodeChange[]
 *    - CodocEditorProvider.analyzeContentChanges() sends 'feedbackChanges' message
 *    - feedbackDecorationExtension receives changes and decorates add/modify/remove
 * 
 * 2. ImpactAnalysisService → feedforwardService
 *    - ImpactAnalysisService.analyzeEditImpact() uses OpenAI to suggest changes
 *    - Based on dependency graph and edited nodes
 *    - CodocEditorProvider.analyzeImpact() sends 'suggestions' message
 *    - feedforwardService receives SuggestedChange[] and shows inline suggestions
 * 
 * 3. Lexer → codocSyntaxHighlighting
 *    - CodocLexer (Chevrotain) tokenizes CoDoc syntax
 *    - codocSyntaxHighlighting ViewPlugin uses lexer tokens
 *    - Applies token-specific CSS classes for syntax highlighting
 * 
 * Message Flow:
 * User Edit → contentChanged → CodocEditorProvider.analyzeContentChanges()
 *   → CodeChangeAnalyzer.analyzeChanges()
 *   → StructuralDiffEngine.compare()
 *   → feedbackChanges message
 *   → showFeedbackDecorationsInView()
 *   → Visual feedback in editor
 * 
 * User Edit → contentChanged → CodocEditorProvider.analyzeImpact()
 *   → ImpactAnalysisService.analyzeEditImpact()
 *   → OpenAI API call
 *   → suggestions message
 *   → applyFeedforwardSuggestions()
 *   → Inline suggestions in editor
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { codocSyntaxHighlighting } from '../lib/editor/codocSyntaxHighlighting';
import { schemaFoldingExtension } from '../lib/editor/schemaFoldingExtension';
import { fileStructureExtension } from '../lib/editor/fileStructureExtension';
import { feedbackDecorationExtension, showFeedbackDecorationsInView, clearFeedbackDecorationsInView, CodocMergeChange } from '../lib/editor/feedbackDecorationExtension';
import { feedforwardExtension, applyFeedforwardSuggestions, clearFeedforwardSuggestions, type FeedforwardSuggestion } from '../lib/editor/feedforwardService';
import { dependencyHighlightExtension, setDependencyGraphInView, highlightAffectedNodesInView, DependencyGraph as DependencyGraphType } from '../lib/editor/dependencyHighlightExtension';
import { 
  activityGutterExtension, 
  addGutterActivityInView, 
  clearGutterActivitiesInView,
  findLineForElement,
  GutterActivityDecoration 
} from '../lib/editor/activityGutterExtension';
import { ActivityStream, ActivityItem } from './ActivityStream';
import { SchemaNode } from '../types';

// VSCode API
declare const acquireVsCodeApi: () => {
  postMessage: (message: any) => void;
  setState: (state: any) => void;
  getState: () => any;
};

const vscode = acquireVsCodeApi();

function detectSuggestionType(text: string): FeedforwardSuggestion['type'] {
  if (text.startsWith('/')) return 'directory';
  if (text.startsWith('%')) return 'component';
  if (text.startsWith('$')) return 'function';
  if (text.startsWith('@')) return 'reference';
  if (text.includes('.')) return 'file';
  return 'variable';
}

export const CodocEditor: React.FC = () => {
  const [content, setContent] = useState('');
  const [parsedSchema, setParsedSchema] = useState<SchemaNode[]>([]);
  const [codebase, setCodebase] = useState<any[]>([]);
  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraphType | null>(null);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const feedforwardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const savedCursorPosRef = useRef<number | null>(null);
  const lastPreviewedLineRef = useRef<number>(-1);
  const previewDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Get EditorView instance from the ref
  const getEditorView = (): EditorView | null => {
    return editorRef.current?.view ?? null;
  };

  // Request feedforward suggestions with debounce
  const requestFeedforward = useCallback((content: string) => {
    // Clear existing timeout
    if (feedforwardTimeoutRef.current) {
      clearTimeout(feedforwardTimeoutRef.current);
    }

    feedforwardTimeoutRef.current = setTimeout(() => {
      vscode.postMessage({
        type: 'requestFeedforward',
        content,
        cursorLine: lastPreviewedLineRef.current,
        cursorColumn: 0,
        parsedSchema
      });
    }, 500);
  }, [parsedSchema]);

  /**
   * Handle rejection of an addition - remove the added element from CoDoc
   */
  const handleRejectAddition = useCallback((change: CodocMergeChange) => {
    const view = getEditorView();
    if (!view) return;

    const doc = view.state.doc;
    const totalLines = doc.lines;

    let targetLineIndex = -1;
    if (change.lineNumber && change.lineNumber > 0 && change.lineNumber <= totalLines) {
      targetLineIndex = change.lineNumber - 1;
    }

    const elementLabel = change.element?.name || change.element?.path || change.id;

    if (targetLineIndex === -1) {
      // Fallback search by element label
      const lines = doc.toString().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (
          trimmed === `$${elementLabel}()` ||
          trimmed === `%${elementLabel}` ||
          trimmed === `/${elementLabel}` ||
          trimmed.endsWith(elementLabel) ||
          trimmed === `@${elementLabel}`
        ) {
          targetLineIndex = i;
          break;
        }
      }
    }

    if (targetLineIndex === -1) {
      console.warn('Could not find element to remove:', elementLabel);
      return;
    }

    const targetLine = doc.line(targetLineIndex + 1);
    const currentIndent = targetLine.text.length - targetLine.text.trimStart().length;
    let lastLineToRemove = targetLineIndex;

    for (let i = targetLineIndex + 1; i < totalLines; i++) {
      const lineInfo = doc.line(i + 1);
      const trimmed = lineInfo.text.trim();
      if (!trimmed) continue;
      const indent = lineInfo.text.length - lineInfo.text.trimStart().length;
      if (indent <= currentIndent) break;
      lastLineToRemove = i;
    }

    let deleteFrom = targetLine.from;
    let deleteTo = doc.line(lastLineToRemove + 1).to;

    // Include trailing newline if present
    if (deleteTo < doc.length && doc.sliceString(deleteTo, deleteTo + 1) === '\n') {
      deleteTo += 1;
    }

    view.dispatch({
      changes: { from: deleteFrom, to: deleteTo, insert: '' }
    });

    console.log(`Rejected addition: removed ${elementLabel} from CoDoc`);
  }, []);

  /**
   * Handle rejection of a removal - restore the removed element to CoDoc
   */
  const handleRejectRemoval = useCallback((change: CodocMergeChange) => {
    const view = getEditorView();
    if (!view) return;

    const doc = view.state.doc;
    const contentToRestore = change.content || '';
    if (!contentToRestore.trim()) {
      console.warn('No content to restore for removal change', change.id);
      return;
    }

    const normalizedContent = contentToRestore.endsWith('\n') ? contentToRestore : `${contentToRestore}\n`;

    let insertPos: number;
    if (change.lineNumber && change.lineNumber > 0 && change.lineNumber <= doc.lines) {
      insertPos = doc.line(change.lineNumber).from;
    } else {
      insertPos = doc.length;
    }

    const needsLeadingNewline = insertPos > 0 && doc.sliceString(insertPos - 1, insertPos) !== '\n';
    const textToInsert = `${needsLeadingNewline ? '\n' : ''}${normalizedContent}`;

    view.dispatch({
      changes: { from: insertPos, insert: textToInsert }
    });

    console.log(`Rejected removal: restored change ${change.id}`);
  }, []);

  // Handle messages from extension - connects backend services to frontend extensions
  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      const message = event.data;
      const view = getEditorView();

      switch (message.type) {
        case 'contentUpdate':
          // Save cursor position before update if requested
          if (message.preserveCursor && view) {
            savedCursorPosRef.current = view.state.selection.main.head;
          }
          setContent(message.content);
          
          // If backend provided a new cursor line (after reordering), use it
          if (message.newCursorLine !== undefined && view) {
            // Convert 1-indexed line number to 0-indexed position
            const lineNumber = message.newCursorLine - 1;
            const line = view.state.doc.line(Math.max(1, Math.min(lineNumber + 1, view.state.doc.lines)));
            savedCursorPosRef.current = line.from;
          }
          break;

        case 'codebaseScanned':
          setParsedSchema(message.parsedSchema || []);
          setCodebase(message.snapshot?.files || []);
          if (message.snapshot?.dependencyGraph) {
            setDependencyGraph(message.snapshot.dependencyGraph);
            const view = getEditorView();
            if (view) {
              setDependencyGraphInView(view, message.snapshot.dependencyGraph);
            }
          }
          break;

        case 'feedbackChanges':
          // StructuralDiffEngine → feedbackDecorationExtension
          // Backend structural analysis drives feedback decorations
          // REPLACES all decorations with AI-generated changes after generation
          if (view && message.changes) {
            const changes = message.changes as CodocMergeChange[];
            showFeedbackDecorationsInView(view, changes);
          }
          break;

        case 'showFeedbackDecorations':
          // New: Show feedback decorations after code generation
          // REPLACES all decorations with new AI changes
          if (view && message.changes) {
            const changes = message.changes as CodocMergeChange[];
            showFeedbackDecorationsInView(view, changes);
          }
          break;

        case 'clearFeedbackDecorations':
          // Clear all feedback decorations
          if (view) {
            clearFeedbackDecorationsInView(view);
          }
          break;

        case 'clearFeedback':
          if (view) {
            clearFeedbackDecorationsInView(view);
          }
          break;

        case 'highlightAffectedNodes':
          // Highlight affected nodes temporarily
          if (view && message.nodeIds) {
            highlightAffectedNodesInView(view, message.nodeIds, message.duration || 1500);
          }
          break;

        // case 'suggestions':
        //   // ImpactAnalysisService → feedforwardService
        //   // Backend impact analysis drives feedforward suggestions
        //   if (view && message.suggestions) {
        //     const suggestions = message.suggestions as SuggestedChange[];
        //     applyFeedforwardSuggestions(view, suggestions);
        //   }
        //   break;

        case 'feedforwardSuggestions':
          // New: Feedforward suggestions from backend
          if (view && message.suggestions) {
            const suggestions = message.suggestions as FeedforwardSuggestion[];
            applyFeedforwardSuggestions(view, suggestions);
          }
          break;

        case 'clearSuggestions':
          if (view) {
            clearFeedforwardSuggestions(view);
          }
          break;

        case 'generationProgress':
          // Show generation progress in UI
          // message.stage: 'starting' | 'thinking' | 'editing' | 'executing' | 'complete' | 'error'
          // message.message: progress message string
          console.log(`[Generation] ${message.stage}: ${message.message}`);
          break;

        case 'generationComplete':
          // Generation finished successfully
          console.log(`[Generation Complete] ${message.summary || 'Done'}`);
          if (message.fileChanges && message.fileChanges.length > 0) {
            console.log(`Files modified:`, message.fileChanges);
          }
          break;

        case 'activityEvent':
          // Activity stream events from OpenCode SDK
          if (message.event) {
            const event = message.event;
            const newItem: ActivityItem = {
              id: event.id || `activity-${Date.now()}`,
              type: event.eventType,
              message: event.message,
              timestamp: event.timestamp || Date.now(),
              filePath: event.filePath,
              componentName: event.componentName,
              additions: event.additions,
              deletions: event.deletions
            };
            setActivityItems(prev => {
              // Keep max 50 items
              const updated = [...prev, newItem];
              return updated.slice(-50);
            });
          }
          break;

        case 'gutterDecoration':
          // Gutter decoration for tool activities
          if (view && message.decoration) {
            const decoration = message.decoration as GutterActivityDecoration;
            // Try to find the line for this element in the CoDoc
            const lineNumber = findLineForElement(
              view, 
              decoration.filePath || '',
              decoration.componentName
            );
            if (lineNumber) {
              addGutterActivityInView(view, {
                ...decoration,
                lineNumber
              });
            }
          }
          break;

        case 'clearActivityStream':
          // Clear all activity stream items
          setActivityItems([]);
          break;

        case 'clearGutterDecorations':
          // Clear all gutter decorations
          if (view) {
            clearGutterActivitiesInView(view);
          }
          break;
      }
    };

    // Handle custom events from feedback decorations
    const feedbackRejectionHandler = (event: Event) => {
      const customEvent = event as CustomEvent<{ change?: CodocMergeChange }>;
      const change = customEvent.detail?.change;
      if (!change) {
        return;
      }

      if (change.type === 'add') {
        handleRejectAddition(change);
      } else if (change.type === 'remove') {
        handleRejectRemoval(change);
      } else {
        vscode.postMessage({
          type: 'rejectFeedbackChange',
          changeId: change.id,
          changeType: change.type,
          content: change.content
        });
      }
    };

    window.addEventListener('message', messageHandler);
    window.addEventListener('feedbackChangeRejected', feedbackRejectionHandler);
    return () => {
      window.removeEventListener('message', messageHandler);
      window.removeEventListener('feedbackChangeRejected', feedbackRejectionHandler);
      // Clean up feedforward timeout on unmount
      if (feedforwardTimeoutRef.current) {
        clearTimeout(feedforwardTimeoutRef.current);
      }
      // Clean up preview debounce timer on unmount
      if (previewDebounceTimerRef.current) {
        clearTimeout(previewDebounceTimerRef.current);
      }
    };
  }, [parsedSchema, codebase]);

  // Update dependency graph in view when it changes
  useEffect(() => {
    if (dependencyGraph) {
      const view = getEditorView();
      if (view) {
        setDependencyGraphInView(view, dependencyGraph);
      }
    }
  }, [dependencyGraph]);

  // Restore cursor position after content updates
  useEffect(() => {
    if (savedCursorPosRef.current !== null) {
      const view = getEditorView();
      if (view) {
        const pos = Math.min(savedCursorPosRef.current, content.length);
        view.dispatch({
          selection: { anchor: pos, head: pos },
          scrollIntoView: true
        });
        savedCursorPosRef.current = null;
      }
    }
  }, [content]);

  const handleSyncCodebase = useCallback(() => {
    vscode.postMessage({ type: 'syncCodebase' });
  }, []);

  const handleGenerateCode = useCallback(() => {
    // Clear previous feedback before generating
    const view = getEditorView();
    if (view) {
      clearFeedbackDecorationsInView(view);
    }
    vscode.postMessage({ type: 'generateCode' });
  }, []);

  const handleMockGenerateCode = useCallback(() => {
    // Clear previous feedback before generating
    const view = getEditorView();
    if (view) {
      clearFeedbackDecorationsInView(view);
    }
    vscode.postMessage({ type: 'mockGenerateCode' });
  }, []);

  const handleClearFeedback = useCallback(() => {
    const view = getEditorView();
    if (view) {
      clearFeedbackDecorationsInView(view);
    }
    vscode.postMessage({ type: 'clearAllFeedback' });
  }, []);

  const handleContentChange = useCallback((value: string) => {
    setContent(value);
    vscode.postMessage({
      type: 'contentChanged',
      content: value
    });
    
    // Trigger feedforward generation on content changes
    // requestFeedforward(value);
  }, [requestFeedforward]);

  // Handle cursor position changes for preview
  const handleCursorChange = useCallback((cursorLine: number) => {
    // Only trigger preview if cursor moved to a different line
    if (cursorLine === lastPreviewedLineRef.current) {
      return;
    }

    // Clear any pending preview requests
    if (previewDebounceTimerRef.current) {
      clearTimeout(previewDebounceTimerRef.current);
    }

    // Debounce preview requests (only trigger after cursor stops moving)
    previewDebounceTimerRef.current = setTimeout(() => {
      // Check if there's a node at this line
      const hasNodeAtLine = parsedSchema.some(node => {
        const checkNode = (n: SchemaNode): boolean => {
          if (n.lineNumber === cursorLine + 1) return true;
          if (n.children) {
            return n.children.some(checkNode);
          }
          return false;
        };
        return checkNode(node);
      });

      // Only send message if there's a node at this line
      if (hasNodeAtLine) {
        lastPreviewedLineRef.current = cursorLine;
        vscode.postMessage({
          type: 'cursorPositionChanged',
          lineNumber: cursorLine + 1, // Convert to 1-based
          parsedSchema
        });
      }
    }, 300); // 300ms debounce - only trigger after cursor settles
  }, [parsedSchema]);

  // Combine all extensions
  const extensions = React.useMemo(() => [
    fileStructureExtension(),           // Visual structure icons
    codocSyntaxHighlighting(),          // Parser-driven syntax highlighting (lexer.ts)
    ...schemaFoldingExtension(),        // Schema-aware folding
    ...feedbackDecorationExtension(),   // Feedback from StructuralDiffEngine
    ...feedforwardExtension(),          // Suggestions from ImpactAnalysisService
    ...dependencyHighlightExtension(),  // Dependency-based opacity highlighting
    activityGutterExtension(),          // AI activity gutter icons
    EditorView.updateListener.of((update) => {
      // Track cursor position changes
      if (update.selectionSet) {
        const cursorPos = update.state.selection.main.head;
        const cursorLine = update.state.doc.lineAt(cursorPos).number - 1;
        handleCursorChange(cursorLine);
      }
    })
  ], [handleCursorChange]);

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: '100vh',
      backgroundColor: 'var(--vscode-editor-background)',
      color: 'var(--vscode-editor-background)'
    }}>
      {/* Minimal toolbar with just two small buttons */}
      <div style={{ 
        padding: '4px 8px', 
        borderBottom: '1px solid var(--vscode-panel-border)',
        display: 'flex',
        gap: '8px',
        alignItems: 'center'
      }}>
        <button 
          onClick={handleSyncCodebase}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            backgroundColor: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: '2px',
            cursor: 'pointer'
          }}
        >
          Sync
        </button>
        <button 
          onClick={handleGenerateCode}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            backgroundColor: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: '2px',
            cursor: 'pointer'
          }}
        >
          Generate
        </button>
        <button 
          onClick={handleMockGenerateCode}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            backgroundColor: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: '2px',
            cursor: 'pointer'
          }}
          title="Mock generation for testing (no OpenCode)"
        >
          Mock Gen
        </button>
        <button 
          onClick={handleClearFeedback}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            backgroundColor: 'var(--vscode-button-secondaryBackground)',
            color: 'var(--vscode-button-secondaryForeground)',
            border: '1px solid var(--vscode-button-border)',
            borderRadius: '2px',
            cursor: 'pointer'
          }}
          title="Clear all feedback decorations"
        >
          Clear Feedback
        </button>
      </div>

      {/* Main editor using @uiw/react-codemirror */}
      <CodeMirror
        ref={editorRef}
        value={content}
        onChange={handleContentChange}
        extensions={extensions}
        style={{ 
          flex: 1,
          fontSize: '14px',
          lineHeight: '1.6',
          height: '100%',
          minHeight: 0  // Allow flex shrink
        }}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          history: true,
          foldGutter: true,
          drawSelection: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
          crosshairCursor: true,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          searchKeymap: true,
          foldKeymap: true,
          completionKeymap: false,
          lintKeymap: true,
        }}
      />

      {/* Activity stream at bottom */}
      <ActivityStream activities={activityItems} maxVisible={3} />
    </div>
  );
};
