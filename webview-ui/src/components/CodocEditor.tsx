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
  const [isGenerating, setIsGenerating] = useState(false);
    const shouldReserveActivitySpace = isGenerating || activityItems.length > 0;

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
          setIsGenerating(false);
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
            let lineNumber: number | null = null;

            if (decoration.filePath) {
              lineNumber = findLineForElement(
                view,
                decoration.filePath,
                decoration.componentName
              );
            }

            if (!lineNumber && decoration.lineNumber && decoration.lineNumber > 0) {
              lineNumber = decoration.lineNumber;
            }

            if (lineNumber) {
              addGutterActivityInView(view, {
                ...decoration,
                lineNumber
              });
            } else {
              console.warn('Unable to resolve gutter decoration line', decoration);
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
    if (isGenerating) {
      setIsGenerating(false);
      vscode.postMessage({ type: 'stopGeneration' });
    } else {
      const view = getEditorView();
      if (view) {
        clearFeedbackDecorationsInView(view);
      }
      setIsGenerating(true);
      vscode.postMessage({ type: 'generateCode' });
    }
  }, []);

  const handleContentChange = useCallback((value: string) => {
    setContent(value);
    vscode.postMessage({
      type: 'contentChanged',
      content: value
    });

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

  // dark theme with black background and gray text
  const darkTheme = EditorView.theme({
    '&': {
      backgroundColor: '#000000',
      color: '#d4d4d4'
    },
    '.cm-content': {
      backgroundColor: '#000000',
      color: '#d4d4d4',
      caretColor: '#d4d4d4'
    },
    '.cm-editor': {
      backgroundColor: '#000000'
    },
    '.cm-scroller': {
      backgroundColor: '#000000'
    },
    '.cm-gutters': {
      backgroundColor: '#000000',
      borderRight: '1px solid #333333',
      color: '#999999'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: '#999999'
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#1a1a1a'
    },
    '.cm-activeLine': {
      backgroundColor: '#1a1a1a'
    },
    '.cm-selectionMatch': {
      backgroundColor: '#333333'
    },
    '.cm-selectionBackground': {
      backgroundColor: '#333333'
    },
    '.cm-cursor': {
      borderLeftColor: '#d4d4d4'
    },
    '.cm-focused .cm-cursor': {
      borderLeftColor: '#d4d4d4'
    },
    '.cm-focused .cm-selectionBackground': {
      backgroundColor: '#333333'
    }
  }, { dark: true });

  // Combine all extensions
  const extensions = React.useMemo(() => [
    darkTheme,                          // Custom dark theme
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
      backgroundColor: '#000000',
      color: '#d4d4d4',
      position: 'relative'
    }}>
      {/* Vertical button group - floating on top right */}
      <div style={{
        position: 'absolute',
        top: '8px',
        right: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        zIndex: 1000,
        opacity: 0.8,
        transition: 'opacity 0.2s ease'
      }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}>
        {/* Sync Button */}
        <button
          onClick={handleSyncCodebase}
          disabled={isGenerating}
          title="Sync Codebase - Analyze current workspace and update CoDoc"
          style={{
            width: '30px',
            height: '30px',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: isGenerating ? '#555555' : '#519aba',
            color: '#ffffff',
            cursor: isGenerating ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
          }}
          onMouseEnter={(e) => {
            if (!isGenerating) {
              e.currentTarget.style.backgroundColor = '#498ba7';
              e.currentTarget.style.transform = 'scale(1.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isGenerating) {
              e.currentTarget.style.backgroundColor = '#519aba';
              e.currentTarget.style.transform = 'scale(1)';
            }
          }}
        >
          {isGenerating ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" opacity="0.3" />
              <path d="M12 2 a10 10 0 0 1 10 10" strokeLinecap="round">
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0 12 12"
                  to="360 12 12"
                  dur="1s"
                  repeatCount="indefinite" />
              </path>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          )}
        </button>

        {/* Agentic Generate Button */}
        <button
          onClick={handleGenerateCode}
          disabled={parsedSchema.length === 0 && !isGenerating}
          title={isGenerating ? "Stop Agentic Generation" : "Agentic Generate - Intelligent Code Generation with Auto-Approve"}
          style={{
            width: '30px',
            height: '30px',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: isGenerating ? '#d13438' : (parsedSchema.length === 0 ? '#333333' : '#519aba'),
            color: '#ffffff',
            cursor: (parsedSchema.length === 0 && !isGenerating) ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            opacity: (parsedSchema.length === 0 && !isGenerating) ? 0.5 : 1
          }}
          onMouseEnter={(e) => {
            if (parsedSchema.length > 0 || isGenerating) {
              e.currentTarget.style.backgroundColor = isGenerating ? '#b52d30' : '#498ba7';
              e.currentTarget.style.transform = 'scale(1.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (parsedSchema.length > 0 || isGenerating) {
              e.currentTarget.style.backgroundColor = isGenerating ? '#d13438' : '#519aba';
              e.currentTarget.style.transform = 'scale(1)';
            }
          }}
        >
          {isGenerating ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="2" />
              <rect x="14" y="4" width="4" height="16" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M97.8357 54.6682C177.199 59.5311 213.038 52.9891 238.043 52.9891C261.298 52.9891 272.24 129.465 262.683 152.048C253.672 173.341 100.331 174.196 93.1919 165.763C84.9363 156.008 89.7095 115.275 89.7095 101.301" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M98.3318 190.694C-10.6597 291.485 121.25 273.498 148.233 295.083" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M98.3301 190.694C99.7917 213.702 101.164 265.697 100.263 272.898" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M208.308 136.239C208.308 131.959 208.308 127.678 208.308 123.396" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M177.299 137.271C177.035 133.883 177.3 126.121 177.3 123.396" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M203.398 241.72C352.097 239.921 374.881 226.73 312.524 341.851" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M285.55 345.448C196.81 341.85 136.851 374.229 178.223 264.504" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M180.018 345.448C160.77 331.385 139.302 320.213 120.658 304.675" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M218.395 190.156C219.024 205.562 219.594 220.898 219.594 236.324" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M218.395 190.156C225.896 202.037 232.97 209.77 241.777 230.327" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M80.1174 119.041C75.5996 120.222 71.0489 119.99 66.4414 120.41" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M59.5935 109.469C59.6539 117.756 59.5918 125.915 58.9102 134.086" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M277.741 115.622C281.155 115.268 284.589 114.823 287.997 114.255" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M291.412 104.682C292.382 110.109 292.095 115.612 292.095 121.093" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M225.768 116.466C203.362 113.993 181.657 115.175 160.124 118.568" stroke="#ffffff" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>
          )}
        </button>
      </div>

      {/* Main editor using @uiw/react-codemirror */}
      <div style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        paddingBottom: shouldReserveActivitySpace ? '100px' : '0'
      }}>
        <CodeMirror
          ref={editorRef}
          value={content}
          onChange={handleContentChange}
          extensions={extensions}
          style={{
            fontSize: '14px',
            lineHeight: '1.6',
            height: '100%',
            minHeight: 0
          }}
          basicSetup={{
            lineNumbers: false,
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
      </div>

      {/* Activity stream at bottom */}
      <ActivityStream
        activities={activityItems}
        maxVisible={3}
        isGenerating={isGenerating}
      />
    </div>
  );
};
