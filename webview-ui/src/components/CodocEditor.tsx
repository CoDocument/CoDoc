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
import { feedbackDecorationExtension, showFeedbackDecorationsInView, clearFeedbackDecorationsInView, addFeedbackDecorationsInView, CodocMergeChange } from '../lib/editor/feedbackDecorationExtension';
import { feedforwardExtension, applyFeedforwardSuggestions, clearFeedforwardSuggestions } from '../lib/editor/feedforwardService';
import { dependencyHighlightExtension, setDependencyGraphInView, DependencyGraph as DependencyGraphType } from '../lib/editor/dependencyHighlightExtension';
import { SchemaNode, SuggestedChange } from '../types';

// VSCode API
declare const acquireVsCodeApi: () => {
  postMessage: (message: any) => void;
  setState: (state: any) => void;
  getState: () => any;
};

const vscode = acquireVsCodeApi();

export const CodocEditor: React.FC = () => {
  const [content, setContent] = useState('');
  const [parsedSchema, setParsedSchema] = useState<SchemaNode[]>([]);
  const [codebase, setCodebase] = useState<any[]>([]);
  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraphType | null>(null);
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // Get EditorView instance from the ref
  const getEditorView = (): EditorView | null => {
    return editorRef.current?.view ?? null;
  };

  // Handle messages from extension - connects backend services to frontend extensions
  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      const message = event.data;
      const view = getEditorView();

      switch (message.type) {
        case 'contentUpdate':
          setContent(message.content);
          break;

        case 'codebaseScanned':
          setParsedSchema(message.parsedSchema || []);
          setCodebase(message.snapshot?.files || []);
          // Set dependency graph for highlighting
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
          // Use addFeedbackDecorationsInView to accumulate changes across generations
          if (view && message.changes) {
            const changes = message.changes as CodocMergeChange[];
            addFeedbackDecorationsInView(view, changes);
          }
          break;

        case 'showFeedbackDecorations':
          // New: Show feedback decorations after code generation
          // Use addFeedbackDecorationsInView to accumulate changes
          if (view && message.changes) {
            const changes = message.changes as CodocMergeChange[];
            addFeedbackDecorationsInView(view, changes);
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

        case 'suggestions':
          // ImpactAnalysisService → feedforwardService
          // Backend impact analysis drives feedforward suggestions
          if (view && message.suggestions) {
            const suggestions = message.suggestions as SuggestedChange[];
            applyFeedforwardSuggestions(view, suggestions);
          }
          break;

        case 'clearSuggestions':
          if (view) {
            clearFeedforwardSuggestions(view);
          }
          break;

        case 'generationComplete':
          // After generation, analyze and show diff
          vscode.postMessage({ type: 'analyzeChanges' });
          break;
      }
    };

    window.addEventListener('message', messageHandler);
    return () => window.removeEventListener('message', messageHandler);
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
  }, []);

  // Combine all extensions
  const extensions = React.useMemo(() => [
    fileStructureExtension(),           // Visual structure icons
    codocSyntaxHighlighting(),          // Parser-driven syntax highlighting (lexer.ts)
    ...schemaFoldingExtension(),        // Schema-aware folding
    ...feedbackDecorationExtension(),   // Feedback from StructuralDiffEngine
    ...feedforwardExtension(),          // Suggestions from ImpactAnalysisService
    ...dependencyHighlightExtension(),  // Dependency-based opacity highlighting
  ], []);

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
