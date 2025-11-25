/**
 * OpenCodeService - Terminal-based wrapper for OpenCode integration
 * Handles authentication, code generation, and terminal management
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { OpenCodeRequest, OpenCodeResponse } from '../types';

export class OpenCodeService {
  private terminal: vscode.Terminal | undefined;
  private workspaceRoot: string | undefined;
  private isInitialized: boolean = false;
  private outputBuffer: string = '';

  /**
   * Get or create the OpenCode terminal
   */
  private async getOrCreateTerminal(workDir: string): Promise<vscode.Terminal> {
    // Reuse existing terminal if same workspace and terminal still exists
    if (this.terminal && this.workspaceRoot === workDir) {
      // Check if terminal is still alive
      const allTerminals = vscode.window.terminals;
      if (allTerminals.includes(this.terminal)) {
        return this.terminal;
      }
    }

    // Create new terminal
    this.terminal = vscode.window.createTerminal({
      name: 'OpenCode',
      cwd: workDir,
      message: 'OpenCode Terminal - Ready for code generation'
    });

    this.workspaceRoot = workDir;
    this.isInitialized = false;

    // Show the terminal to user
    this.terminal.show(true); // preserveFocus = true

    return this.terminal;
  }

  /**
   * Initialize OpenCode terminal with the project
   * Runs 'opencode' and then '/init' command
   */
  async initializeTerminal(workDir: string): Promise<void> {
    const terminal = await this.getOrCreateTerminal(workDir);
    terminal.sendText('opencode', true);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // terminal.sendText('/init', true);
    // await new Promise(resolve => setTimeout(resolve, 1000));

    this.isInitialized = true;

    vscode.window.showInformationMessage(
      'OpenCode terminal initialized. You can now generate code.'
    );
  }

  /**
   * Check if OpenCode CLI is authenticated
   */
  async checkAuth(): Promise<boolean> {
    try {
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        exec('opencode whoami', (error: any) => {
          resolve(!error);
        });
      });
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate code using OpenCode Terminal
   * Sends prompt directly to the existing OpenCode session
   */
  async generate(
    request: OpenCodeRequest,
    onProgress?: (line: string) => void
  ): Promise<OpenCodeResponse> {
    try {
      // Ensure terminal is initialized
      if (!this.isInitialized) {
        await this.initializeTerminal(request.workDir);
      }

      const terminal = await this.getOrCreateTerminal(request.workDir);

      // Show terminal to user so they can see the progress
      terminal.show(false); // preserveFocus = false, bring terminal to front

      // Send the prompt directly to OpenCode
      // Since we're already in OpenCode mode, we just send the prompt
      terminal.sendText(JSON.stringify(request.prompt), true);

      // Show info message
      vscode.window.showInformationMessage(
        'OpenCode is generating code. Watch the terminal for progress...'
      );

      // For now, we return a success response immediately
      // In the future, we could monitor terminal output using shell integration
      return {
        success: true,
        output: 'Generation in progress. Check the OpenCode terminal for details.',
        summary: 'Code generation started in OpenCode terminal.',
        error: undefined
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        summary: '',
        error: String(error)
      };
    }
  }

  /**
   * Start a new OpenCode session
   */
  async startNewSession(): Promise<void> {
    if (this.terminal && this.isInitialized) {
      this.terminal.sendText('/new', true);
      vscode.window.showInformationMessage('Started new OpenCode session');
    }
  }

  /**
   * Dispose the terminal
   */
  dispose(): void {
    if (this.terminal) {
      // Send exit command first
      this.terminal.sendText('/exit', true);
      // Then dispose
      setTimeout(() => {
        this.terminal?.dispose();
        this.terminal = undefined;
        this.isInitialized = false;
        this.workspaceRoot = undefined;
      }, 500);
    }
  }


  /**
   * Store generation history
   */
  async storeHistory(
    workDir: string,
    prompt: string,
    response: string,
    summary: string,
    affectedFiles: string[]
  ): Promise<void> {
    const historyDir = path.join(workDir, '.codoc');
    const historyFile = path.join(historyDir, 'history.json');

    // Ensure .codoc directory exists
    try {
      await fs.mkdir(historyDir, { recursive: true });
    } catch (error) {
      // Directory exists
    }

    // Load existing history
    let history: any[] = [];
    try {
      const content = await fs.readFile(historyFile, 'utf-8');
      history = JSON.parse(content);
    } catch (error) {
      // File doesn't exist yet
    }

    // Add new entry
    history.push({
      timestamp: Date.now(),
      prompt,
      response,
      summary,
      affectedFiles
    });

    // Keep only last 50 entries
    if (history.length > 50) {
      history = history.slice(-50);
    }

    // Save
    await fs.writeFile(historyFile, JSON.stringify(history, null, 2), 'utf-8');
  }

  /**
   * Load generation history
   */
  async loadHistory(workDir: string): Promise<any[]> {
    const historyFile = path.join(workDir, '.codoc', 'history.json');
    try {
      const content = await fs.readFile(historyFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      return [];
    }
  }
}

export const openCodeService = new OpenCodeService();
