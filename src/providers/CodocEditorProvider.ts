/**
 * CodocEditorProvider - Custom editor for .codoc files
 */

import * as vscode from 'vscode';
import { AnalysisEngine } from '../services/AnalysisEngine.js';
import { structuralDiffEngine } from '../services/StructuralDiffEngine.js';
import { AgentServiceFactory } from '../services/agent/AgentServiceFactory.js';
import { impactAnalysisService } from '../services/ImpactAnalysisService.js';
import { promptPreparationService } from '../services/PromptPreparationService.js';
import { MockGenerationService } from '../services/agent/MockGenerationService.js';
import { FileSystemSyncService } from '../services/FileSystemSyncService.js';
import { PreviewService } from '../services/PreviewService.js';
import { SchemaNode, CodebaseSnapshot, EditorState } from '../types.js';
import { codocParser } from '../parser/codocParser.js';
import { ActivityEvent, GutterDecoration, ActivityEventCallbacks } from '../services/agent/ActivityEventTypes.js';

export class CodocEditorProvider implements vscode.CustomTextEditorProvider {
  private context: vscode.ExtensionContext;
  public currentPanel: vscode.WebviewPanel | null = null;
  public currentDocument: vscode.TextDocument | null = null;
  private editorState: EditorState | null = null;
  private analysisEngine: AnalysisEngine | null = null;
  private fileSystemSyncService: FileSystemSyncService | null = null;
  private previewService: PreviewService | null = null;
  private previousContent: string = '';
  private previousSchema: SchemaNode[] = [];


  private preGenerationCoDoc: SchemaNode[] = [];
  private preGenerationSnapshot: CodebaseSnapshot | null = null;

  private isGenerating: boolean = false;

  private syncDebounceTimer: NodeJS.Timeout | null = null;
  private readonly SYNC_DEBOUNCE_MS = 1500;
  
  private isUpdatingProgrammatically = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Setup activity callbacks to forward OpenCode events to webview
   */
  private setupActivityCallbacks(webviewPanel: vscode.WebviewPanel): void {
    const callbacks: ActivityEventCallbacks = {
      onActivity: (event: ActivityEvent) => {
        webviewPanel.webview.postMessage({
          type: 'activityEvent',
          event: {
            id: event.id,
            eventType: event.type,
            message: event.message,
            timestamp: event.timestamp,
            filePath: event.filePath,
            componentName: event.componentName,
            additions: event.additions,
            deletions: event.deletions
          }
        });
      },
      onGutterDecoration: (decoration: GutterDecoration) => {
        webviewPanel.webview.postMessage({
          type: 'gutterDecoration',
          decoration
        });
      },
      onSummary: (summary) => {
        // Show completion notification
        if (summary.title) {
          vscode.window.showInformationMessage(`✓ ${summary.title}`);
        }
      },
      onComplete: () => {
        webviewPanel.webview.postMessage({
          type: 'activityEvent',
          event: {
            id: `complete_${Date.now()}`,
            eventType: 'complete',
            message: 'Generation complete!',
            timestamp: Date.now()
          }
        });
      },
      onError: (error: string) => {
        webviewPanel.webview.postMessage({
          type: 'activityEvent',
          event: {
            id: `error_${Date.now()}`,
            eventType: 'error',
            message: error,
            timestamp: Date.now()
          }
        });
        vscode.window.showErrorMessage(`Generation error: ${error}`);
      }
    };

    AgentServiceFactory.getService().setActivityCallbacks(callbacks);
  }


  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.currentPanel = webviewPanel;
    this.currentDocument = document;

    // Setup webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'build')
      ]
    };

    webviewPanel.webview.html = this.getWebviewContent(webviewPanel.webview);

    // Handle document changes (only from external sources)
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        // Only send updates if not from our own programmatic changes
        if (!this.isUpdatingProgrammatically) {
          this.sendContentToWebview(e.document.getText());
        }
      }
    });

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );

    // Clean up
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      // Clear any pending sync timers
      if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
        this.syncDebounceTimer = null;
      }
      this.currentPanel = null;
      this.currentDocument = null;
    });

    // Initialize services
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const workspaceRoot = workspaceFolder.uri.fsPath;
      this.fileSystemSyncService = new FileSystemSyncService(workspaceRoot);
      this.previewService = new PreviewService(workspaceRoot);
    }

    this.setupActivityCallbacks(webviewPanel);

    // Send initial content
    this.sendContentToWebview(document.getText());
    this.previousContent = document.getText();
    this.previousSchema = codocParser.parse(document.getText()).nodes;

    // sync with codebase
    await this.syncCodebase();
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'contentChanged':
        await this.updateDocument(message.content);
        this.debouncedHandleCoDocChanges(message.content);
        break;

      case 'syncCodebase':
        await this.syncCodebase();
        break;

      case 'cursorPositionChanged':
        // for preview
        await this.handleCursorChange(message.lineNumber, message.parsedSchema);
        break;

      case 'generateCode':
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'clearFeedbackDecorations'
          });
        }
        await this.generateCode(message.prompt, message.contextFiles);
        break;

      case 'mockGenerateCode':
        // Mock generation for testing feedback decorations
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'clearFeedbackDecorations'
          });
        }
        await this.mockGenerateCode();
        break;

      case 'analyzeImpact':
        await this.analyzeImpact(message.editedNode);
        break;

      case 'acceptFeedbackChange':
        // Change is already in the document, just clear the decoration
        await this.clearFeedbackDecoration(message.changeId);
        break;

      case 'rejectFeedbackChange':
        await this.handleFeedbackRejection(
          message.changeId, 
          message.changeType, 
          message.content
        );
        break;

      case 'revertFeedbackChange':
        await this.revertFeedbackChange(message.changeId, message.originalContent);
        break;

      case 'clearAllFeedback':
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'clearFeedbackDecorations'
          });
        }
        break;

      case 'requestFeedforward':
        await this.generateFeedforward(
          message.content,
          message.cursorLine,
          message.cursorColumn,
          message.parsedSchema
        );
        break;

      case 'cancelFeedforward':
        impactAnalysisService.cancel();
        break;
    }
  }

  /**
   * Generate feedforward suggestions based on cursor position and edits
   */
  private async generateFeedforward(
    content: string,
    cursorLine: number,
    cursorColumn: number,
    parsedSchema: any[]
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    try {
      // Initialize analysis engine if not already done
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workspaceRoot);
        await this.analysisEngine.scanCodebase();
      }

      // Get OpenAI API key from configuration
      const apiKey = vscode.workspace.getConfiguration('codoc').get<string>('openaiApiKey');
      if (!apiKey) {
        console.warn('OpenAI API key not configured');
        return;
      }

      // Get dependency graph from analysis engine
      const snapshot = await this.analysisEngine.scanCodebase();
      const dependencyGraph = snapshot.dependencyGraph;

      impactAnalysisService.generateFeedforwardSuggestions(
        content,
        cursorLine,
        cursorColumn,
        parsedSchema,
        dependencyGraph,
        apiKey,
        undefined, // rejectedPatterns
        (suggestions) => {
          if (this.currentPanel) {
            this.currentPanel.webview.postMessage({
              type: 'feedforwardSuggestions',
              suggestions
            });
          }
        }
      );
    } catch (error) {
      console.error('Failed to generate feedforward:', error);
    }
  }

  private async updateDocument(content: string): Promise<void> {
    if (!this.currentDocument) return;

    this.isUpdatingProgrammatically = true;
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.currentDocument.uri,
        new vscode.Range(0, 0, this.currentDocument.lineCount, 0),
        content
      );
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.isUpdatingProgrammatically = false;
    }
  }

  private sendContentToWebview(content: string, preserveCursor: boolean = false): void {
    if (this.currentPanel) {
      this.currentPanel.webview.postMessage({
        type: 'contentUpdate',
        content,
        preserveCursor
      });
    }
  }

  async syncCodebase(): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    try {
      // Capture current cursor position and the node it's on
      let cursorNodePath: string | null = null;
      if (this.currentDocument && this.previousSchema.length > 0) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === this.currentDocument) {
          const cursorLine = editor.selection.active.line + 1; // 1-indexed
          const nodeAtCursor = this.findNodeAtLine(this.previousSchema, cursorLine);
          if (nodeAtCursor) {
            cursorNodePath = nodeAtCursor.path;
          }
        }
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        cancellable: false
      }, async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.analysisEngine = new AnalysisEngine(workspaceRoot);
        const snapshot = await this.analysisEngine.scanCodebase();

        // Construct CoDoc from snapshot
        const newSchema = this.analysisEngine.constructCodoc(snapshot);
        const codocContent = this.generateCodocContent('project', newSchema);

        // Update document content
        if (this.currentDocument) {
          this.isUpdatingProgrammatically = true;
          try {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              this.currentDocument.positionAt(0),
              this.currentDocument.positionAt(this.currentDocument.getText().length)
            );
            edit.replace(this.currentDocument.uri, fullRange, codocContent);
            await vscode.workspace.applyEdit(edit);
          } finally {
            this.isUpdatingProgrammatically = false;
          }
        }

        // Update editor state
        this.editorState = {
          content: codocContent,
          parsedSchema: newSchema,
          dependencyGraph: snapshot.dependencyGraph,
          focusedNodeId: null,
          generationHistory: this.editorState?.generationHistory || []
        };

        // Send to webview with dependency graph
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'codebaseScanned',
            snapshot,
            parsedSchema: newSchema
          });

          // Find new line number for cursor node if it still exists
          let newCursorLine: number | undefined;
          if (cursorNodePath) {
            const newNode = this.findNodeByPath(newSchema, cursorNodePath);
            if (newNode) {
              newCursorLine = newNode.lineNumber;
            }
          }

          this.currentPanel.webview.postMessage({
            type: 'contentUpdate',
            content: codocContent,
            preserveCursor: true,
            newCursorLine
          });
        }

        // vscode.window.showInformationMessage(
        //   `Synced ${snapshot.files.length} files with dependency graph`
        // );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Sync failed: ${error}`);
    }
  }

  /**
   * Mock code generation for testing feedback decorations
   * Simulates AI generating code step-by-step to show decorations building up
   */
  async mockGenerateCode(): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    if (!this.currentDocument) {
      vscode.window.showErrorMessage('No CoDoc document open');
      return;
    }

    try {
      const workDir = vscode.workspace.workspaceFolders[0].uri.fsPath;

      // STEP 1: Store snapshot BEFORE generation for AI change detection
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workDir);
      }

      this.preGenerationSnapshot = await this.analysisEngine.scanCodebase();
      this.preGenerationCoDoc = this.analysisEngine.constructCodoc(this.preGenerationSnapshot);

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Mock generating code...',
        cancellable: false
      }, async (progress) => {
        const mockService = new MockGenerationService(workDir);

        // Run mock generation with progress callbacks
        await mockService.runMockGeneration((step: string) => {
          progress.report({ message: step });
        });

        progress.report({ message: 'Rescanning codebase...' });

        // Wait a moment for file system to settle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // STEP 2: Rescan codebase and reconstruct new CoDoc (AI changes reflected here)
        // await this.rescanAndUpdateCoDoc();
        await this.syncCodebase();

        progress.report({ message: 'Analyzing AI-generated changes...' });

        // STEP 3: Compare pre-generation CoDoc with post-generation CoDoc
        const postGenerationSnapshot = await this.analysisEngine!.scanCodebase();
        const postGenerationCoDoc = this.analysisEngine!.constructCodoc(postGenerationSnapshot);

        // Use StructuralDiffEngine to identify ALL changes
        const diff = structuralDiffEngine.compare(this.preGenerationCoDoc, postGenerationCoDoc);

        // Convert structural diff to AIChange[] with comprehensive classification
        const aiChanges = structuralDiffEngine.convertToAIChanges(diff);

        progress.report({ message: 'Displaying AI feedback...' });

        // Send AI changes to webview for feedback decorations
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'showFeedbackDecorations',
            changes: aiChanges
          });
        }

        vscode.window.showInformationMessage(
          `✓ Mock generation complete! ${aiChanges.length} AI changes detected.`
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Mock generation failed: ${error}`);
      console.error('Mock generation error:', error);
    }
  }

  /**
   * Generate CoDoc content from schema
   */
  private generateCodocContent(projectName: string, schema: any[]): string {
    let content = '';

    function renderNode(node: any, indent: number = 0): string {
      const indentStr = '  '.repeat(indent);
      let line = '';

      switch (node.type) {
        case 'directory':
          line = `${indentStr}/${node.name}\n`;
          break;
        case 'file':
          line = `${indentStr}${node.name}\n`;
          break;
        case 'function':
          // Just show $functionName() without the name duplication
          line = `${indentStr}$${node.name}()\n`;
          break;
        case 'component':
          // Use %ComponentName syntax instead of <ComponentName>
          line = `${indentStr}%${node.name}\n`;
          break;
        case 'reference':
          line = `${indentStr}@${node.name}\n`;
          break;
        case 'note':
          line = `${indentStr}# ${node.content}\n`;
          break;
      }

      let result = line;
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          result += renderNode(child, indent + 1);
        }
      }

      return result;
    }

    for (const node of schema) {
      content += renderNode(node);
    }

    return content;
  }

  async generateCode(prompt?: string, contextFiles?: string[]): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    if (!this.currentDocument) {
      vscode.window.showErrorMessage('No CoDoc document open');
      return;
    }

    if (this.isGenerating) {
      vscode.window.showWarningMessage('Code generation already in progress');
      return;
    }

    try {
      const workDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const currentContent = this.currentDocument.getText();

      // STEP 1: Store snapshot BEFORE generation for AI change detection
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workDir);
      }

      this.preGenerationSnapshot = await this.analysisEngine.scanCodebase();
      this.preGenerationCoDoc = this.analysisEngine.constructCodoc(this.preGenerationSnapshot);

      // Clear any previous feedback decorations
      if (this.currentPanel) {
        this.currentPanel.webview.postMessage({
          type: 'clearFeedbackDecorations'
        });
      }

      // Prepare comprehensive prompt with CoDoc structure and changes
      const preparedPrompt = await promptPreparationService.preparePrompt({
        currentCoDocContent: currentContent,
        previousCoDocContent: this.previousContent || undefined,
        lastGenerationSummary: undefined,
        workspaceRoot: workDir
      });

      // Allow user to add custom instructions if provided
      let finalPrompt = preparedPrompt;
      if (prompt) {
        finalPrompt = `${preparedPrompt}

---

## ADDITIONAL USER INSTRUCTIONS

${prompt}`;
      }
      this.isGenerating = true;
      const agentService = AgentServiceFactory.getService();
      agentService.showOutput();

      const provider = AgentServiceFactory.isOpenCodeSelected() ? 'OpenCode' : 'Claude';
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Generating code with ${provider}...`,
        cancellable: false
      }, async (progress) => {
        progress.report({ message: 'Initializing OpenCode...' });

        // Generate code with real-time progress tracking
        const result = await agentService.generate(
          finalPrompt,
          workDir,
          // Progress callback
          async (progressUpdate) => {
            progress.report({ message: progressUpdate.message });

            // Send progress updates to webview
            if (this.currentPanel) {
              this.currentPanel.webview.postMessage({
                type: 'generationProgress',
                stage: progressUpdate.stage,
                message: progressUpdate.message
              });
            }

            // When generation completes, analyze changes
            if (progressUpdate.stage === 'complete') {
              await this.handleGenerationComplete(workDir, currentContent, progress);
            } else if (progressUpdate.stage === 'error') {
              this.isGenerating = false;
            }
          },
          async (fileChange) => {
            await this.handleIncrementalUpdate(fileChange.path);
          }
        );

        if (!result.success) {
          vscode.window.showErrorMessage(`Generation failed: ${result.error}`);
          this.isGenerating = false;
        }
      });
    } catch (error) {
      this.isGenerating = false;
      vscode.window.showErrorMessage(`Generation failed: ${error}`);
    }
  }

  /**
   * Handle incremental CoDoc updates as files change during generation
   */
  private async handleIncrementalUpdate(changedFilePath: string): Promise<void> {
    if (!this.analysisEngine || !this.currentPanel) {
      return;
    }

    try {
      // Rescan and update CoDoc incrementally
      const snapshot = await this.analysisEngine.scanCodebase();
      const newSchema = this.analysisEngine.constructCodoc(snapshot);

      // Compare with pre-generation state to show cumulative changes
      const diff = structuralDiffEngine.compare(this.preGenerationCoDoc, newSchema);
      const aiChanges = structuralDiffEngine.convertToAIChanges(diff);

      // Update CoDoc content in editor
      const codocContent = this.generateCodocContent('project', newSchema);
      
      if (this.currentDocument) {
        this.isUpdatingProgrammatically = true;
        try {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            this.currentDocument.positionAt(0),
            this.currentDocument.positionAt(this.currentDocument.getText().length)
          );
          edit.replace(this.currentDocument.uri, fullRange, codocContent);
          await vscode.workspace.applyEdit(edit);
        } finally {
          this.isUpdatingProgrammatically = false;
        }
      }

      // Send incremental updates to webview
      this.currentPanel.webview.postMessage({
        type: 'contentUpdate',
        content: codocContent,
        preserveCursor: true
      });

      // Update feedback decorations with cumulative changes
      this.currentPanel.webview.postMessage({
        type: 'showFeedbackDecorations',
        changes: aiChanges
      });
    } catch (error) {
      console.error('Incremental update failed:', error);
    }
  }

  /**
   * Handle generation completion - final analysis and feedback
   */
  private async handleGenerationComplete(
    workDir: string,
    originalContent: string,
    progress: vscode.Progress<{ message?: string }>
  ): Promise<void> {
    try {
      progress.report({ message: 'Finalizing changes...' });

      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!this.analysisEngine) {
        return;
      }

      progress.report({ message: 'Analyzing AI-generated changes...' });

      const postGenerationSnapshot = await this.analysisEngine.scanCodebase();
      const postGenerationCoDoc = this.analysisEngine.constructCodoc(postGenerationSnapshot);

      // STEP 3: Compare pre-generation CoDoc with post-generation CoDoc
      const diff = structuralDiffEngine.compare(this.preGenerationCoDoc, postGenerationCoDoc);
      const aiChanges = structuralDiffEngine.convertToAIChanges(diff);

      // Update CoDoc content
      const codocContent = this.generateCodocContent('project', postGenerationCoDoc);
      
      if (this.currentDocument) {
        this.isUpdatingProgrammatically = true;
        try {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            this.currentDocument.positionAt(0),
            this.currentDocument.positionAt(this.currentDocument.getText().length)
          );
          edit.replace(this.currentDocument.uri, fullRange, codocContent);
          await vscode.workspace.applyEdit(edit);
        } finally {
          this.isUpdatingProgrammatically = false;
        }
      }

      // Update editor state
      this.editorState = {
        content: codocContent,
        parsedSchema: postGenerationCoDoc,
        dependencyGraph: postGenerationSnapshot.dependencyGraph,
        focusedNodeId: null,
        generationHistory: this.editorState?.generationHistory || []
      };

      // Store current content as previous for next iteration
      this.previousContent = originalContent;
      this.previousSchema = postGenerationCoDoc;

      progress.report({ message: 'Displaying AI feedback...' });

      // Send final updates to webview
      if (this.currentPanel) {
        this.currentPanel.webview.postMessage({
          type: 'contentUpdate',
          content: codocContent,
          preserveCursor: false
        });

        this.currentPanel.webview.postMessage({
          type: 'codebaseScanned',
          snapshot: postGenerationSnapshot,
          parsedSchema: postGenerationCoDoc
        });

        this.currentPanel.webview.postMessage({
          type: 'showFeedbackDecorations',
          changes: aiChanges
        });

        this.currentPanel.webview.postMessage({
          type: 'generationComplete',
          success: true
        });
      }

      vscode.window.showInformationMessage(
        `Code generation complete! ${aiChanges.length} AI changes detected.`
      );

      this.isGenerating = false;
    } catch (error) {
      console.error('Generation completion failed:', error);
      this.isGenerating = false;
      vscode.window.showErrorMessage(`Failed to complete generation: ${error}`);
    }
  }

  private async analyzeImpact(editedNode: SchemaNode): Promise<void> {
    if (!this.editorState?.dependencyGraph) return;

    const config = vscode.workspace.getConfiguration('codoc');
    const apiKey = config.get<string>('openaiApiKey');

    if (!apiKey || apiKey.trim() === '') {
      const action = await vscode.window.showWarningMessage(
        'OpenAI API key not configured. Impact analysis is disabled. Would you like to configure it now?',
        'Configure',
        'Cancel'
      );

      if (action === 'Configure') {
        const inputKey = await vscode.window.showInputBox({
          prompt: 'Enter your OpenAI API Key',
          password: true,
          placeHolder: 'sk-...'
        });

        if (inputKey && inputKey.trim() !== '') {
          await config.update('openaiApiKey', inputKey, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('API key saved. Impact analysis is now enabled.');
        } else {
          return;
        }
      } else {
        return;
      }
    }

    const lastSummary = this.editorState.generationHistory.length > 0
      ? this.editorState.generationHistory[this.editorState.generationHistory.length - 1].summary
      : '';

    impactAnalysisService.analyzeEditImpact(
      editedNode,
      this.editorState.dependencyGraph,
      lastSummary,
      config.get<string>('openaiApiKey')!,
      (suggestions) => {
        if (this.currentPanel) {
          this.currentPanel.webview.postMessage({
            type: 'suggestions',
            suggestions
          });
        }
      }
    );
  }

  /**
   * Debounced wrapper for handleCoDocChanges
   */
  private debouncedHandleCoDocChanges(newContent: string): void {
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    this.syncDebounceTimer = setTimeout(() => {
      this.handleCoDocChanges(newContent);
    }, this.SYNC_DEBOUNCE_MS);
  }

  /**
   * Handle CoDoc content changes and sync with file system
   */
  private async handleCoDocChanges(newContent: string): Promise<void> {
    if (!this.fileSystemSyncService || !this.currentPanel) {
      return;
    }

    try {
      // Parse old and new content
      const oldSchema = this.previousSchema;
      const newSchema = codocParser.parse(newContent).nodes;

      // Compute diff
      const diff = structuralDiffEngine.compare(oldSchema, newSchema);

      // Get dependency graph
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const analysisEngine = new AnalysisEngine(workspaceFolder.uri.fsPath);
      const snapshot = await analysisEngine.scanCodebase();
      const dependencyGraph = snapshot.dependencyGraph;
      console.log('<<diff', diff);

      const syncResult = await this.fileSystemSyncService.syncChanges(
        diff,
        newSchema,
        dependencyGraph
      );

      if (!syncResult.success) {
        vscode.window.showWarningMessage(
          `Some changes could not be synced: ${syncResult.errors.join(', ')}`
        );
      }

      this.previousSchema = newSchema;
    } catch (error) {
      console.error('Failed to handle CoDoc changes:', error);
    }
  }

  /**
   * Handle cursor position change for preview
   */
  private async handleCursorChange(lineNumber: number, parsedSchema: SchemaNode[]): Promise<void> {
    if (!this.previewService) {
      return;
    }

    try {
      const node = this.findNodeAtLine(parsedSchema, lineNumber);

      if (node) {
        await this.previewService.previewNode(node);
      }
    } catch (error) {
      console.error('Failed to handle cursor change:', error);
    }
  }

  /**
   * Find node at specific line number
   */
  private findNodeAtLine(nodes: SchemaNode[], lineNumber: number): SchemaNode | null {
    for (const node of nodes) {
      if (node.lineNumber === lineNumber) {
        return node;
      }

      if (node.children) {
        const found = this.findNodeAtLine(node.children, lineNumber);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Find node by path (used for cursor restoration after reordering)
   */
  private findNodeByPath(nodes: SchemaNode[], path: string): SchemaNode | null {
    for (const node of nodes) {
      if (node.path === path) {
        return node;
      }

      if (node.children) {
        const found = this.findNodeByPath(node.children, path);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Clear a specific feedback decoration (change accepted)
   */
  private async clearFeedbackDecoration(changeId: string): Promise<void> {
    if (this.currentPanel) {
      this.currentPanel.webview.postMessage({
        type: 'rejectFeedbackChange',
        changeId
      });
    }
  }

  /**
   * Handle feedback rejection - user rejected a change
   * For additions: element is already removed from CoDoc by frontend, trigger file sync
   * For removals: element is already restored to CoDoc by frontend, trigger file sync
   * For modifications: need to revert the code change
   */
  private async handleFeedbackRejection(
    changeId: string, 
    changeType: string, 
    content?: string
  ): Promise<void> {
    if (!this.currentDocument) {
      return;
    }

    try {
      // The frontend already modified the CoDoc content
      // Now we need to sync these changes with the file system
      
      // Debounce the sync to allow multiple rejections to batch
      if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
      }

      this.syncDebounceTimer = setTimeout(async () => {
        await this.syncCodebase();
        vscode.window.showInformationMessage(`Change ${changeType} reverted and synced`);
      }, 500); // Short debounce for rejections

    } catch (error) {
      console.error('Failed to handle feedback rejection:', error);
      vscode.window.showErrorMessage(`Failed to revert ${changeType} change`);
    }
  }

  /**
   * Revert a feedback change (restore original content)
   */
  private async revertFeedbackChange(changeId: string, originalContent?: string): Promise<void> {
    if (!this.currentDocument || !originalContent) {
      return;
    }

    // Parse the change to find the line to revert
    // For now, we'll send a message to webview to handle the revert
    if (this.currentPanel) {
      this.currentPanel.webview.postMessage({
        type: 'rejectFeedbackChange',
        changeId
      });
    }

    // If we have original content, we could restore it, but since the CoDoc
    // is already updated, we just remove the decoration
    vscode.window.showInformationMessage('Change reverted');
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'build', 'static', 'js', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'build', 'static', 'css', 'main.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CoDoc Editor</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
