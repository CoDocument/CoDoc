/**
 * OpenCodeService - CLI wrapper for OpenCode integration
 * Handles authentication, code generation, and output parsing
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OpenCodeRequest, OpenCodeResponse } from '../types';

export class OpenCodeService {
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
   * Generate code using OpenCode CLI
   */
  async generate(
    request: OpenCodeRequest,
    onProgress?: (line: string) => void
  ): Promise<OpenCodeResponse> {
    try {
      // Build command using 'opencode run'
      // OpenCode directly modifies files in the workspace, no JSON output expected
      const model = request.model || 'anthropic/claude-4-5-sonnet-20241022';
      
      // Escape the prompt for shell
      const escapedPrompt = request.prompt
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
      
      // Build command with model and prompt
      const command = `opencode run "${escapedPrompt}"`;

      console.log('Executing OpenCode command:', command);
      // Execute command and wait for completion
      const { output, exitCode } = await this.executeCommand(command, request.workDir);
      console.log('OpenCode Output:', output, exitCode);

      // Extract summary from output
      const summary = this.extractSummary(output);

      return {
        success: exitCode === 0,
        output,
        summary,
        error: exitCode !== 0 ? 'OpenCode command failed' : undefined
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
   * Execute shell command and capture output
   */
  private async executeCommand(
    command: string,
    cwd: string
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(
        command,
        { cwd, maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer
        (error: any, stdout: string, stderr: string) => {
          const output = stdout + stderr;
          const exitCode = error ? (error.code || 1) : 0;
          resolve({ output, exitCode });
        }
      );
    });
  }



  /**
   * Extract SUMMARY section from OpenCode response
   * Looks for common summary patterns in LLM output
   */
  extractSummary(output: string): string {
    // Try to find explicit SUMMARY section (case insensitive)
    const summaryMatch = output.match(/(?:^|\n)\s*(?:##?\s*)?SUMMARY[:\s]*\n([\s\S]*?)(?:\n\n|\n##|$)/i);
    if (summaryMatch) {
      return summaryMatch[1].trim();
    }

    // Try to find "In summary" or "Summary:" patterns
    const inSummaryMatch = output.match(/(?:^|\n)\s*(?:In summary|Summary)[:\s,]+([\s\S]*?)(?:\n\n|$)/i);
    if (inSummaryMatch) {
      return inSummaryMatch[1].trim();
    }

    // Try to find changes/modifications section
    const changesMatch = output.match(/(?:^|\n)\s*(?:##?\s*)?(?:Changes Made|Modifications)[:\s]*\n([\s\S]*?)(?:\n\n|\n##|$)/i);
    if (changesMatch) {
      return changesMatch[1].trim();
    }

    // Fallback: Get last substantial paragraph
    const paragraphs = output.split(/\n\n+/).filter(p => p.trim().length > 20);
    if (paragraphs.length > 0) {
      const lastParagraph = paragraphs[paragraphs.length - 1].trim();
      // Limit to reasonable summary length
      if (lastParagraph.length <= 500) {
        return lastParagraph;
      }
      return lastParagraph.substring(0, 500) + '...';
    }

    return 'Code generation completed. Check workspace for changes.';
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
