/**
 * AgentServiceFactory - Factory pattern for selecting the appropriate code generation service
 * Supports both OpenCode SDK and Claude Agent SDK based on user configuration
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../ConfigManager.js';
import { OpenCodeSDKService } from './OpenCodeSDKService.js';
import { ClaudeCodeService } from './ClaudeCodeService.js';

export type AgentService = OpenCodeSDKService | ClaudeCodeService;

/**
 * Factory for creating and managing agent services
 */
export class AgentServiceFactory {
  private static instance: AgentService | null = null;
  private static currentProvider: string | null = null;

  /**
   * Get or create the appropriate service based on current configuration
   * Creates a new instance if the provider has changed
   */
  static getService(): AgentService {
    const provider = ConfigManager.getSDKProvider();
    
    // If provider has changed, reinitialize
    if (this.currentProvider !== provider) {
      this.currentProvider = provider;
      this.instance = this.createService(provider);
    }

    // Return existing instance or create if none exists
    if (!this.instance) {
      this.instance = this.createService(provider);
    }

    return this.instance;
  }

  /**
   * Create a new service instance based on the provider type
   */
  private static createService(provider: 'opencode' | 'claude'): AgentService {
    if (provider === 'opencode') {
      return new OpenCodeSDKService();
    } else {
      return new ClaudeCodeService();
    }
  }

  /**
   * Check if OpenCode service is currently selected
   */
  static isOpenCodeSelected(): boolean {
    return ConfigManager.getSDKProvider() === 'opencode';
  }

  /**
   * Check if Claude service is currently selected
   */
  static isClaudeSelected(): boolean {
    return ConfigManager.getSDKProvider() === 'claude';
  }

  /**
   * Switch to OpenCode service
   */
  static async switchToOpenCode(): Promise<void> {
    await ConfigManager.setSDKProvider('opencode');
    // Force recreation on next getService() call
    this.currentProvider = null;
    this.instance = null;
  }

  /**
   * Switch to Claude service
   */
  static async switchToClaude(): Promise<void> {
    await ConfigManager.setSDKProvider('claude');
    // Force recreation on next getService() call
    this.currentProvider = null;
    this.instance = null;
  }

  /**
   * Dispose current service and reset
   */
  static dispose(): void {
    if (this.instance) {
      this.instance.dispose();
    }
    this.instance = null;
    this.currentProvider = null;
  }

  /**
   * Validate that the selected service is properly configured
   * Returns { isValid: boolean, message?: string }
   */
  static async validateCurrentService(): Promise<{ isValid: boolean; message?: string }> {
    const provider = ConfigManager.getSDKProvider();

    if (provider === 'opencode') {
      // For OpenCode, we'd need to check if server is running
      // This is more of a runtime check
      return {
        isValid: true,
        message: 'OpenCode SDK selected. Make sure to run "opencode serve" in a terminal.'
      };
    } else {
      // For Claude, check if API key is configured
      const hasKey = ConfigManager.hasClaudeApiKey();
      if (!hasKey) {
        return {
          isValid: false,
          message: 'Claude API key not configured. Please set codoc.claudeApiKey in VS Code settings.'
        };
      }
      return {
        isValid: true,
        message: 'Claude Agent SDK configured and ready.'
      };
    }
  }
}
