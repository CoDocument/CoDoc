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

    // Cancel any pending feedforward requests
    vscode.postMessage({ type: 'cancelFeedforward' });

    // Debounce feedforward request
    feedforwardTimeoutRef.current = setTimeout(() => {
      const view = getEditorView();
      if (!view) return;

      const cursorPos = view.state.selection.main.head;
      const cursorLine = view.state.doc.lineAt(cursorPos).number - 1;
      const cursorColumn = cursorPos - view.state.doc.line(cursorLine + 1).from;

      vscode.postMessage({
        type: 'requestFeedforward',
        content,
        cursorLine,
        cursorColumn,
        parsedSchema
      });
    }, 800); // 800ms debounce
  }, [parsedSchema]);

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
      }
    };

    window.addEventListener('message', messageHandler);
    return () => {
      window.removeEventListener('message', messageHandler);
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
          height: '100%'
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
    </div>
  );
};
