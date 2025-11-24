/**
 * Main extension activation point
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodocEditorProvider } from './providers/CodocEditorProvider';
import { AnalysisEngine } from './services/AnalysisEngine';
import { openCodeService } from './services/OpenCodeService';

let editorProvider: CodocEditorProvider;
let fileWatcher: vscode.FileSystemWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('CoDoc extension activated');

  // Register custom editor provider
  editorProvider = new CodocEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'codoc.editor',
      editorProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.initCoDoc', async () => {
      await initCoDocFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.openEditor', async () => {
      await openCoDocEditor();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.syncCodebase', async () => {
      if (editorProvider.currentPanel) {
        await editorProvider.syncCodebase();
      } else {
        vscode.window.showWarningMessage('No CoDoc editor is open');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.generateWithOpenCode', async () => {
      if (editorProvider.currentPanel) {
        await editorProvider.generateCode();
      } else {
        vscode.window.showWarningMessage('No CoDoc editor is open');
      }
    })
  );

  // Register language configuration
  vscode.languages.setLanguageConfiguration('codoc', {
    comments: {
      lineComment: '#'
    },
    brackets: [],
    wordPattern: /[-\w.\/]+/
  });

  // Setup file watcher for auto-sync
  setupAutoSync();
}

export function deactivate() {
  console.log('CoDoc extension deactivated');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  // Dispose OpenCode terminal
  openCodeService.dispose();
}

/**
 * Initialize CoDoc file for the workspace
 */
async function initCoDocFile(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const workspaceName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9]/g, '_');
  const codocFileName = `${workspaceName}.codoc`;
  const codocFilePath = path.join(workspaceRoot, codocFileName);

  // Check if .codoc file already exists
  if (fs.existsSync(codocFilePath)) {
    const action = await vscode.window.showInformationMessage(
      `${codocFileName} already exists. Open it?`,
      'Open',
      'Cancel'
    );
    if (action === 'Open') {
      await openCoDocEditor();
    }
    return;
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Initializing CoDoc...',
      cancellable: false
    }, async (progress) => {
      progress.report({ message: 'Scanning codebase...' });

      // Scan codebase and construct CoDoc
      const analysisEngine = new AnalysisEngine(workspaceRoot);
      const snapshot = await analysisEngine.scanCodebase();
      const schema = analysisEngine.constructCodoc(snapshot);

      progress.report({ message: 'Generating CoDoc file...' });

      // Generate CoDoc content
      const codocContent = generateCodocContent(workspaceName, schema);

      // Write to file
      fs.writeFileSync(codocFilePath, codocContent, 'utf-8');

      progress.report({ message: 'Done!' });
    });

    vscode.window.showInformationMessage(`Created ${codocFileName}`);

    // Open the newly created file
    const uri = vscode.Uri.file(codocFilePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'codoc.editor');

  } catch (error) {
    vscode.window.showErrorMessage(`Failed to initialize CoDoc: ${error}`);
  }
}

/**
 * Open CoDoc editor
 */
async function openCoDocEditor(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  
  // Find .codoc files in workspace root
  const files = fs.readdirSync(workspaceRoot);
  const codocFiles = files.filter(f => f.endsWith('.codoc'));

  if (codocFiles.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No CoDoc file found. Initialize one?',
      'Initialize',
      'Cancel'
    );
    if (action === 'Initialize') {
      await initCoDocFile();
    }
    return;
  }

  if (codocFiles.length === 1) {
    const uri = vscode.Uri.file(path.join(workspaceRoot, codocFiles[0]));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'codoc.editor');
  } else {
    // Multiple .codoc files, let user choose
    const selected = await vscode.window.showQuickPick(codocFiles, {
      placeHolder: 'Select a CoDoc file to open'
    });
    if (selected) {
      const uri = vscode.Uri.file(path.join(workspaceRoot, selected));
      await vscode.commands.executeCommand('vscode.openWith', uri, 'codoc.editor');
    }
  }
}

/**
 * Generate CoDoc content from schema
 */
function generateCodocContent(projectName: string, schema: any[]): string {
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

/**
 * Setup auto-sync watcher
 */
function setupAutoSync(): void {
  const config = vscode.workspace.getConfiguration('codoc');
  const autoSync = config.get<boolean>('autoSync', true);

  if (!autoSync) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  // Watch for file changes in workspace
  fileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolders[0], '**/*.{ts,tsx,js,jsx,py,java,cpp,c,go,rs}')
  );

  const syncCoDoc = async () => {
    if (editorProvider.currentDocument) {
      await editorProvider.syncWithCodebase();
    }
  };

  fileWatcher.onDidCreate(syncCoDoc);
  fileWatcher.onDidChange(syncCoDoc);
  fileWatcher.onDidDelete(syncCoDoc);
}
