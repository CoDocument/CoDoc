/**
 * Main extension activation point
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodocEditorProvider } from './providers/CodocEditorProvider.js';
import { AnalysisEngine } from './services/AnalysisEngine.js';
import { ConfigManager } from './services/ConfigManager.js';
import { AgentServiceFactory } from './services/agent/AgentServiceFactory.js';

let editorProvider: CodocEditorProvider;
let fileWatcher: vscode.FileSystemWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('CoDoc extension activated');
  console.log('Extension host Node version:', process.version);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.openCodeInstall', async () => {
      await runOpenCodeInstall();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.openCodeAuth', async () => {
      await runOpenCodeAuth();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.openCodeServe', async () => {
      await runOpenCodeServe();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.setupOpenCode', async () => {
      await setupOpenCodeCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.setupClaude', async () => {
      await setupClaudeCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codoc.configureApiKeys', async () => {
      await ConfigManager.openApiKeySettings();
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

  // Check for API keys in workspace settings and prompt migration
  ConfigManager.promptForMigration();

  // Show welcome message with setup options
  showSetupWelcome();

  // Listen for SDK provider changes and auto-reset settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('codoc.sdkProvider')) {
        await handleSDKProviderChange();
      }
    })
  );
}

/**
 * Handle SDK provider changes - reset irrelevant settings
 */
async function handleSDKProviderChange(): Promise<void> {
  const provider = ConfigManager.getSDKProvider();
  const config = vscode.workspace.getConfiguration('codoc');

  if (provider === 'opencode') {
    // User switched to OpenCode - reset Claude settings
    await config.update('claudeApiKey', '', vscode.ConfigurationTarget.Global);
  } else if (provider === 'claude') {
    // User switched to Claude - reset OpenCode settings
    await config.update('openCodeSetupStep1', false, vscode.ConfigurationTarget.Global);
    await config.update('openCodeSetupStep2', false, vscode.ConfigurationTarget.Global);
    await config.update('openCodeSetupStep3', false, vscode.ConfigurationTarget.Global);
  }
}

export function deactivate() {
  console.log('CoDoc extension deactivated');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  // Dispose agent service
  AgentServiceFactory.dispose();
}

/**
 * Show welcome message with SDK provider options
 */
async function showSetupWelcome(): Promise<void> {
  // Only show on first activation or if not configured
  const provider = ConfigManager.getSDKProvider();
  const config = vscode.workspace.getConfiguration('codoc');
  
  // Check if user has made an explicit choice
  const inspection = config.inspect('sdkProvider');
  if (inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined) {
    return; // User has already configured
  }

  const choice = await vscode.window.showInformationMessage(
    'Welcome to CoDoc! Choose your code generation engine:',
    'OpenCode SDK (Local Server)',
    'Claude Agent SDK (API Key)',
    'Later'
  );

  if (choice === 'OpenCode SDK (Local Server)') {
    await AgentServiceFactory.switchToOpenCode();
    const setupChoice = await vscode.window.showInformationMessage(
      'Ready to setup OpenCode SDK?',
      'Setup Now',
      'Setup Later'
    );
    if (setupChoice === 'Setup Now') {
      await setupOpenCodeCommand();
    }
  } else if (choice === 'Claude Agent SDK (API Key)') {
    await AgentServiceFactory.switchToClaude();
    const setupChoice = await vscode.window.showInformationMessage(
      'Ready to configure Claude API key?',
      'Configure Now',
      'Configure Later'
    );
    if (setupChoice === 'Configure Now') {
      await setupClaudeCommand();
    }
  }
}

/**
 * Setup OpenCode SDK command handler
 * Guides user through: npm install, auth login, serve
 */
async function setupOpenCodeCommand(): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Install OpenCode CLI', description: 'npm install -g opencode-ai' },
      { label: 'Login to OpenCode', description: 'opencode auth login' },
      { label: 'Start OpenCode Server', description: 'opencode serve -p 4096 --hostname 127.0.0.1' }
    ],
    { placeHolder: 'Select OpenCode setup step', canPickMany: false }
  );

  if (!choice) {
    return;
  }

  const terminal = vscode.window.createTerminal('OpenCode Setup');
  terminal.show();

  switch (choice.label) {
    case 'Install OpenCode CLI':
      terminal.sendText('npm install -g opencode-ai', true);
      vscode.window.showInformationMessage(
        'Installing OpenCode CLI... Check the terminal for progress.',
        'OK'
      );
      break;

    case 'Login to OpenCode':
      terminal.sendText('opencode auth login', true);
      vscode.window.showInformationMessage(
        'Please complete authentication in the terminal.',
        'OK'
      );
      break;

    case 'Start OpenCode Server':
      terminal.sendText('opencode serve -p 4096 --hostname 127.0.0.1', true);
      vscode.window.showInformationMessage(
        'OpenCode server started! It will run at http://127.0.0.1:4096',
        'OK'
      );
      // Switch provider to opencode
      await AgentServiceFactory.switchToOpenCode();
      break;
  }
}

/**
 * Setup Claude SDK command handler
 * Opens settings to configure API key
 */
async function setupClaudeCommand(): Promise<void> {
  // Switch provider to claude
  await AgentServiceFactory.switchToClaude();

  // Open settings to configure API key
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    'codoc.claudeApiKey'
  );

  vscode.window.showInformationMessage(
    'Paste your Anthropic API key in the settings field. Get one at https://console.anthropic.com/keys',
    'OK'
  );
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
 * Generate CoDoc content
 */
function generateCodocContent(name: string, schema: any): string {
  return `# ${name}

## Directory Structure
${schema}

## Components

## Functions

## Dependencies
`;
}

/**
 * Step 1: Install OpenCode CLI
 */
async function runOpenCodeInstall(): Promise<void> {
  const terminal = vscode.window.createTerminal('OpenCode Setup - Step 1');
  terminal.show();
  terminal.sendText('npm install -g opencode-ai', true);
  
  await vscode.window.showInformationMessage(
    'Installing OpenCode CLI globally...\nPlease wait for installation to complete. You can check progress in the terminal.',
    'OK'
  );

  // Mark step 1 as completed
  const config = vscode.workspace.getConfiguration('codoc');
  await config.update('openCodeSetupStep1', true, vscode.ConfigurationTarget.Global);
}

/**
 * Step 2: Login to OpenCode
 */
async function runOpenCodeAuth(): Promise<void> {
  const terminal = vscode.window.createTerminal('OpenCode Setup - Step 2');
  terminal.show();
  terminal.sendText('opencode auth login', true);
  
  await vscode.window.showInformationMessage(
    'OpenCode authentication started in terminal.\nFollow the prompts to login to your OpenCode account.\nYou may need to select a model during authentication.',
    'OK'
  );

  // Mark step 2 as completed
  const config = vscode.workspace.getConfiguration('codoc');
  await config.update('openCodeSetupStep2', true, vscode.ConfigurationTarget.Global);
}

/**
 * Step 3: Start OpenCode Server
 */
async function runOpenCodeServe(): Promise<void> {
  const terminal = vscode.window.createTerminal('OpenCode Server');
  terminal.show();
  terminal.sendText('opencode serve -p 4096 --hostname 127.0.0.1', true);
  
  await vscode.window.showInformationMessage(
    'OpenCode server is starting on http://127.0.0.1:4096\nThe terminal will remain open to show server status.\nKeep this terminal running while using CoDoc.',
    'OK'
  );

  // Mark step 3 as completed and switch provider
  const config = vscode.workspace.getConfiguration('codoc');
  await config.update('openCodeSetupStep3', true, vscode.ConfigurationTarget.Global);
  await AgentServiceFactory.switchToOpenCode();
}

/**
 * Setup file watcher for auto-sync
 */
function setupAutoSync(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Watch for file changes
  fileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '**/*.{ts,tsx,js,jsx,py,java,go,rb,php}'),
    false,
    false,
    true
  );

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  fileWatcher.onDidChange(uri => {
    const path = uri.fsPath;
    
    // Debounce rapid changes
    if (debounceTimers.has(path)) {
      clearTimeout(debounceTimers.get(path)!);
    }

    const timer = setTimeout(() => {
      if (editorProvider.currentPanel) {
        editorProvider.syncCodebase();
      }
      debounceTimers.delete(path);
    }, 1000);

    debounceTimers.set(path, timer);
  });
}
