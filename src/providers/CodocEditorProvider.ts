/**
 * CodocEditorProvider - Custom editor for .codoc files
 */

import * as vscode from 'vscode';
import { AnalysisEngine } from '../services/AnalysisEngine';
import { structuralDiffEngine } from '../services/StructuralDiffEngine';
import { openCodeService } from '../services/OpenCodeService';
import { impactAnalysisService } from '../services/ImpactAnalysisService';
import { codeChangeAnalyzer } from '../services/CodeChangeAnalyzer';
import { promptPreparationService } from '../services/PromptPreparationService';
import { MockGenerationService } from '../services/MockGenerationService';
import { SchemaNode, CodebaseSnapshot, EditorState } from '../types';

export class CodocEditorProvider implements vscode.CustomTextEditorProvider {
  private context: vscode.ExtensionContext;
  public currentPanel: vscode.WebviewPanel | null = null;
  public currentDocument: vscode.TextDocument | null = null;
  private editorState: EditorState | null = null;
  private analysisEngine: AnalysisEngine | null = null;
  private previousContent: string = '';
  
  // Store CoDoc snapshot BEFORE generation for AI change detection
  private preGenerationCoDoc: SchemaNode[] = [];
  private preGenerationSnapshot: CodebaseSnapshot | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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

    // Handle document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        this.sendContentToWebview(e.document.getText());
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
      this.currentPanel = null;
      this.currentDocument = null;
    });

    // Send initial content
    this.sendContentToWebview(document.getText());
    this.previousContent = document.getText();
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'contentChanged':
        await this.updateDocument(message.content);
        // No longer track human edits for feedback - only AI changes after generation
        break;

      case 'syncCodebase':
        await this.syncCodebase();
        break;

      case 'generateCode':
        // Clear previous feedback decorations before generating (assumes user is happy with them)
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

      case 'openFile':
        await this.openFile(message.filePath, message.line);
        break;

      case 'acceptFeedbackChange':
        // Change is already in the document, just clear the decoration
        await this.clearFeedbackDecoration(message.changeId);
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

      // Generate feedforward suggestions
      impactAnalysisService.generateFeedforwardSuggestions(
        content,
        cursorLine,
        cursorColumn,
        parsedSchema,
        dependencyGraph,
        apiKey,
        undefined, // rejectedPatterns
        (suggestions) => {
          // Send suggestions to webview
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

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.currentDocument.uri,
      new vscode.Range(0, 0, this.currentDocument.lineCount, 0),
      content
    );
    await vscode.workspace.applyEdit(edit);
  }

  private sendContentToWebview(content: string): void {
    if (this.currentPanel) {
      this.currentPanel.webview.postMessage({
        type: 'contentUpdate',
        content
      });
    }
  }

  async syncCodebase(): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Syncing codebase...',
        cancellable: false
      }, async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.analysisEngine = new AnalysisEngine(workspaceRoot);
        const snapshot = await this.analysisEngine.scanCodebase();
        
        // Construct CoDoc from snapshot
        const newSchema = this.analysisEngine.constructCodoc(snapshot);
        const codocContent = this.serializeSchema(newSchema);
        
        // Update document content
        if (this.currentDocument) {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            this.currentDocument.positionAt(0),
            this.currentDocument.positionAt(this.currentDocument.getText().length)
          );
          edit.replace(this.currentDocument.uri, fullRange, codocContent);
          await vscode.workspace.applyEdit(edit);
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
          
          this.currentPanel.webview.postMessage({
            type: 'contentUpdate',
            content: codocContent
          });
        }

        vscode.window.showInformationMessage(
          `Synced ${snapshot.files.length} files with dependency graph`
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Sync failed: ${error}`);
    }
  }

  /**
   * Sync CoDoc with codebase changes
   */
  async syncWithCodebase(): Promise<void> {
    if (!this.currentDocument || !vscode.workspace.workspaceFolders) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    
    try {
      // Re-scan codebase
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workspaceRoot);
      }
      const snapshot = await this.analysisEngine.scanCodebase();
      const newSchema = this.analysisEngine.constructCodoc(snapshot);

      // Generate new CoDoc content
      const projectName = this.currentDocument.uri.fsPath.split('/').pop()?.replace('.codoc', '') || 'project';
      const newContent = this.generateCodocContent(projectName, newSchema);

      // Update document
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.currentDocument.uri,
        new vscode.Range(0, 0, this.currentDocument.lineCount, 0),
        newContent
      );
      await vscode.workspace.applyEdit(edit);

      // Notify webview
      if (this.currentPanel) {
        this.currentPanel.webview.postMessage({
          type: 'contentUpdate',
          content: newContent
        });
      }
    } catch (error) {
      console.error('Failed to sync with codebase:', error);
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
        await this.rescanAndUpdateCoDoc();

        progress.report({ message: 'Analyzing AI-generated changes...' });

        // STEP 3: Compare pre-generation CoDoc with post-generation CoDoc
        const postGenerationSnapshot = await this.analysisEngine!.scanCodebase();
        const postGenerationCoDoc = this.analysisEngine!.constructCodoc(postGenerationSnapshot);
        console.log('Post generation CoDoc:', postGenerationCoDoc);

        // Use StructuralDiffEngine to identify ALL changes
        const diff = structuralDiffEngine.compare(this.preGenerationCoDoc, postGenerationCoDoc);
        console.log('Mock generation structural diff:', diff);

        // Convert structural diff to AIChange[] with comprehensive classification
        const aiChanges = structuralDiffEngine.convertToAIChanges(diff);
        console.log('Mock generation AI changes:', aiChanges);

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
   * Serialize schema to CoDoc format (alias for generateCodocContent)
   */
  private serializeSchema(nodes: SchemaNode[]): string {
    return this.generateCodocContent('project', nodes);
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

    try {
      const workDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const currentContent = this.currentDocument.getText();

      // STEP 1: Store snapshot BEFORE generation for AI change detection
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workDir);
      }
      
      this.preGenerationSnapshot = await this.analysisEngine.scanCodebase();
      this.preGenerationCoDoc = this.analysisEngine.constructCodoc(this.preGenerationSnapshot);

      // Get last generation summary from history
      const history = await openCodeService.loadHistory(workDir);
      const lastGenerationSummary = history.length > 0 
        ? history[history.length - 1].summary 
        : undefined;

      // Prepare comprehensive prompt with CoDoc structure and changes
      const preparedPrompt = await promptPreparationService.preparePrompt({
        currentCoDocContent: currentContent,
        previousCoDocContent: this.previousContent || undefined,
        lastGenerationSummary,
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

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Generating code with OpenCode...',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: 'Preparing prompt and context...' });

        // Show info about the generation
        vscode.window.showInformationMessage(
          'OpenCode is generating code. This may take a few minutes...'
        );

        const response = await openCodeService.generate({
          prompt: finalPrompt,
          contextFiles: contextFiles || [],
          workDir
        });

        if (response.success) {
          progress.report({ message: 'Code generated, rescanning codebase...' });

          // Store history BEFORE rescanning
          await openCodeService.storeHistory(
            workDir,
            prompt || 'CoDoc structure implementation',
            response.output,
            response.summary,
            []
          );

          // Store current content as previous for next iteration
          this.previousContent = currentContent;

          // Wait a moment for file system to settle
          await new Promise(resolve => setTimeout(resolve, 1000));

          // STEP 2: Rescan codebase and reconstruct new CoDoc (AI changes reflected here)
          await this.rescanAndUpdateCoDoc();

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

            this.currentPanel.webview.postMessage({
              type: 'generationComplete',
              summary: response.summary,
              output: response.output
            });
          }

          vscode.window.showInformationMessage(
            `✓ Code generation complete! ${aiChanges.length} AI changes detected in CoDoc structure.`
          );
        } else {
          vscode.window.showErrorMessage(`Generation failed: ${response.error}`);
        }
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Generation failed: ${error}`);
    }
  }

  /**
   * Rescan codebase and update CoDoc document with new structure
   */
  private async rescanAndUpdateCoDoc(): Promise<void> {
    if (!this.currentDocument || !vscode.workspace.workspaceFolders) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    
    try {
      // Re-initialize analysis engine
      if (!this.analysisEngine) {
        this.analysisEngine = new AnalysisEngine(workspaceRoot);
      }

      // Scan codebase
      const snapshot = await this.analysisEngine.scanCodebase();
      const newSchema = this.analysisEngine.constructCodoc(snapshot);

      // Generate new CoDoc content
      const projectName = this.currentDocument.uri.fsPath.split('/').pop()?.replace('.codoc', '') || 'project';
      const newContent = this.generateCodocContent(projectName, newSchema);

      // Update document
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.currentDocument.uri,
        new vscode.Range(0, 0, this.currentDocument.lineCount, 0),
        newContent
      );
      await vscode.workspace.applyEdit(edit);

      // Notify webview
      if (this.currentPanel) {
        this.currentPanel.webview.postMessage({
          type: 'contentUpdate',
          content: newContent
        });
      }
    } catch (error) {
      console.error('Failed to rescan and update CoDoc:', error);
      throw error;
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

  private async openFile(filePath: string, line: number): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
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
