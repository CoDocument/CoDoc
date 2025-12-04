import * as vscode from 'vscode';

export type SDKProvider = 'opencode' | 'claude';

export class ConfigManager {
  /**
   * Get the selected SDK provider
   * Defaults to 'claude' for backwards compatibility
   */
  static getSDKProvider(): SDKProvider {
    const config = vscode.workspace.getConfiguration('codoc');
    const provider = config.get<SDKProvider>('sdkProvider', 'claude');
    return provider;
  }

  /**
   * Set the SDK provider
   */
  static async setSDKProvider(provider: SDKProvider): Promise<void> {
    const config = vscode.workspace.getConfiguration('codoc');
    await config.update('sdkProvider', provider, vscode.ConfigurationTarget.Global);
  }

  /**
   * Get OpenCode server URL
   */
  static getOpenCodeServerUrl(): string {
    const config = vscode.workspace.getConfiguration('codoc');
    return config.get<string>('openCodeServerUrl', 'http://127.0.0.1:4096');
  }

  /**
   * Get Claude API key (alternative to Anthropic API key)
   */
  static getClaudeApiKey(): string {
    const config = vscode.workspace.getConfiguration('codoc');
    const apiKey = config.get<string>('claudeApiKey', '');
    
    if (!apiKey) {
      console.warn('Claude API key not configured. Please configure it in VS Code settings.');
    }
    
    return apiKey;
  }

  static getOpenAiApiKey(): string {
    const config = vscode.workspace.getConfiguration('codoc');
    const apiKey = config.get<string>('openaiApiKey', '');
    
    if (!apiKey) {
      console.warn('OpenAI API key not configured. Please configure it in VS Code settings.');
    }
    
    return apiKey;
  }

  static hasOpenAiApiKey(): boolean {
    return this.getOpenAiApiKey().length > 0;
  }

  static hasAnyApiKey(): boolean {
    return this.hasClaudeApiKey() || this.hasOpenAiApiKey();
  }

  /**
   * Check if the selected SDK provider is OpenCode
   */
  static isOpenCodeSelected(): boolean {
    return this.getSDKProvider() === 'opencode';
  }

  /**
   * Check if the selected SDK provider is Claude
   */
  static isClaudeSelected(): boolean {
    return this.getSDKProvider() === 'claude';
  }

  /**
   * Check if Claude API key is configured
   */
  static hasClaudeApiKey(): boolean {
    return this.getClaudeApiKey().length > 0;
  }


  static async openApiKeySettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codoc.claudeApiKey');
  }

  static async promptForMissingApiKeys(): Promise<boolean> {
    const hasClaudeKey = this.hasClaudeApiKey();
    const hasOpenAiKey = this.hasOpenAiApiKey();

    if (hasClaudeKey && hasOpenAiKey) {
      return true;
    }

    const missingKeys: string[] = [];
    if (!hasClaudeKey) missingKeys.push('Claude API Key');
    if (!hasOpenAiKey) missingKeys.push('OpenAI API Key');

    const message = `Missing ${missingKeys.join(' and ')}. Would you like to configure them now?`;
    const action = await vscode.window.showWarningMessage(message, 'Open Settings', 'Cancel');

    if (action === 'Open Settings') {
      await this.openApiKeySettings();
      return false;
    }

    return false;
  }


  static async ensureApiKey(keyType: 'claude' | 'openai'): Promise<boolean> {
    const hasKey = keyType === 'claude' ? this.hasClaudeApiKey() : this.hasOpenAiApiKey();

    if (!hasKey) {
      const keyName = keyType === 'claude' ? 'Claude' : 'OpenAI';
      const action = await vscode.window.showErrorMessage(
        `${keyName} API key is not configured. Please configure it in VS Code settings.`,
        'Open Settings'
      );

      if (action === 'Open Settings') {
        await this.openApiKeySettings();
      }

      return false;
    }

    return true;
  }


  static hasApiKeysInWorkspaceSettings(): boolean {
    const config = vscode.workspace.getConfiguration('codoc');
    const workspaceConfig = vscode.workspace.getConfiguration();
    

    const workspaceSettings = workspaceConfig.inspect<string>('codoc.claudeApiKey');
    
    return !!(workspaceSettings?.workspaceValue || workspaceSettings?.workspaceFolderValue);
  }


  static async promptForMigration(): Promise<void> {
    if (!this.hasApiKeysInWorkspaceSettings()) {
      return;
    }

    const message = 
      'We detected API keys in your workspace settings.json. For security, we recommend moving them to ' +
      'VS Code user settings to avoid accidentally pushing them to GitHub. Migrate now?';

    const action = await vscode.window.showInformationMessage(
      message,
      'Migrate',
      'Learn More',
      'Later'
    );

    if (action === 'Migrate') {
      vscode.window.showInformationMessage(
        'Please manually set your API keys in VS Code User Settings, then remove them from settings.json.'
      );
      await this.openApiKeySettings();
    } else if (action === 'Learn More') {
      vscode.env.openExternal(
        vscode.Uri.parse('https://code.visualstudio.com/docs/getstarted/settings#_settings-precedence')
      );
    }
  }
}
