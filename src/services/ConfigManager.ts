import * as vscode from 'vscode';

export class ConfigManager {
  static getAnthropicApiKey(): string {
    const config = vscode.workspace.getConfiguration('codoc');
    const apiKey = config.get<string>('anthropicApiKey', '');
    
    if (!apiKey) {
      console.warn('Anthropic API key not configured. Please configure it in VS Code settings.');
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

  static hasAnthropicApiKey(): boolean {
    return this.getAnthropicApiKey().length > 0;
  }


  static hasOpenAiApiKey(): boolean {
    return this.getOpenAiApiKey().length > 0;
  }

  static hasAnyApiKey(): boolean {
    return this.hasAnthropicApiKey() || this.hasOpenAiApiKey();
  }


  static async openApiKeySettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codoc.anthropicApiKey');
  }

  static async promptForMissingApiKeys(): Promise<boolean> {
    const hasAnthropicKey = this.hasAnthropicApiKey();
    const hasOpenAiKey = this.hasOpenAiApiKey();

    if (hasAnthropicKey && hasOpenAiKey) {
      return true;
    }

    const missingKeys: string[] = [];
    if (!hasAnthropicKey) missingKeys.push('Anthropic API Key');
    if (!hasOpenAiKey) missingKeys.push('OpenAI API Key');

    const message = `Missing ${missingKeys.join(' and ')}. Would you like to configure them now?`;
    const action = await vscode.window.showWarningMessage(message, 'Open Settings', 'Cancel');

    if (action === 'Open Settings') {
      await this.openApiKeySettings();
      return false;
    }

    return false;
  }


  static async ensureApiKey(keyType: 'anthropic' | 'openai'): Promise<boolean> {
    const hasKey = keyType === 'anthropic' ? this.hasAnthropicApiKey() : this.hasOpenAiApiKey();

    if (!hasKey) {
      const keyName = keyType === 'anthropic' ? 'Anthropic' : 'OpenAI';
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
    

    const workspaceSettings = workspaceConfig.inspect<string>('codoc.anthropicApiKey');
    
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
