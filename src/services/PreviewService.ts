/**
 * PreviewService
 * 
 * Manages split editor preview functionality for CoDoc.
 * Shows related files and code sections when cursor is on a specific line.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SchemaNode } from '../types';

export interface PreviewConfig {
    enabled: boolean;
    viewColumn: vscode.ViewColumn;
    preserveFocus: boolean;
    revealType: vscode.TextEditorRevealType;
    highlightDuration: number;
}

export class PreviewService {
    private workspaceRoot: string;
    private currentPreviewEditor?: vscode.TextEditor;
    private highlightDecoration: vscode.TextEditorDecorationType;
    private config: PreviewConfig;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(121, 206, 255, 0.3)',
            border: '1px solid rgba(121, 206, 255, 0.5)'
        });

        this.config = {
            enabled: true,
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
            revealType: vscode.TextEditorRevealType.InCenter,
            highlightDuration: 2000
        };
    }

    /**
     * Preview a file or code element based on CoDoc node
     */
    async previewNode(node: SchemaNode): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        try {
            if (node.type === 'file') {
                await this.previewFile(node.path);
            }
            //   else if (node.type === 'directory') {
            //     await this.previewDirectory(node.path);
            //   } 
            else if (node.type === 'function' || node.type === 'component') {
                await this.previewCodeElement(node);
            }
        } catch (error) {
            console.warn(`Failed to preview node ${node.path}:`, error);
        }
    }

    /**
     * Preview a file in split editor
     */
    async previewFile(filePath: string, lineNumber?: number): Promise<void> {
        const fullPath = path.join(this.workspaceRoot, filePath);
        const fileUri = vscode.Uri.file(fullPath);

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: this.config.viewColumn,
                preserveFocus: this.config.preserveFocus,
                preview: true
            });

            this.currentPreviewEditor = editor;

            if (lineNumber !== undefined) {
                const position = new vscode.Position(lineNumber, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(
                    new vscode.Range(position, position),
                    this.config.revealType
                );
                await this.highlightLine(editor, lineNumber);
            }
        } catch (error) {
            console.error(`Failed to preview file ${filePath}:`, error);
        }
    }

    /**
     * Preview a code element (function/component) in its file
     */
    async previewCodeElement(node: SchemaNode): Promise<void> {
        // Find the file containing this element
        const filePath = this.getFilePathForNode(node);
        if (!filePath) {
            return;
        }

        const fullPath = path.join(this.workspaceRoot, filePath);
        const fileUri = vscode.Uri.file(fullPath);

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Find the element position in the file
            const position = await this.findElementPosition(document, node);

            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: this.config.viewColumn,
                preserveFocus: this.config.preserveFocus,
                preview: true
            });

            this.currentPreviewEditor = editor;

            if (position) {
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(
                    new vscode.Range(position, position),
                    this.config.revealType
                );

                // Highlight the entire element
                await this.highlightElement(editor, position, node);
            }
        } catch (error) {
            console.error(`Failed to preview element ${node.name}:`, error);
        }
    }

    /**
     * Preview a directory by revealing it in the explorer
     */
    async previewDirectory(dirPath: string): Promise<void> {
        const fullPath = path.join(this.workspaceRoot, dirPath);
        const dirUri = vscode.Uri.file(fullPath);

        try {
            await vscode.commands.executeCommand('revealInExplorer', dirUri);
        } catch (error) {
            console.error(`Failed to preview directory ${dirPath}:`, error);
        }
    }

    /**
     * Find element position in document
     */
    private async findElementPosition(
        document: vscode.TextDocument,
        node: SchemaNode
    ): Promise<vscode.Position | null> {
        const text = document.getText();
        const lines = text.split('\n');

        // Search for the element by name and type
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (node.type === 'function') {
                // Match function declarations
                const functionPatterns = [
                    new RegExp(`function\\s+${node.name}\\s*\\(`),
                    new RegExp(`const\\s+${node.name}\\s*=.*=>`),
                    new RegExp(`${node.name}\\s*:\\s*function`),
                    new RegExp(`${node.name}\\s*\\([^)]*\\)\\s*{`), // Arrow functions
                ];

                for (const pattern of functionPatterns) {
                    if (pattern.test(line)) {
                        return new vscode.Position(i, 0);
                    }
                }
            } else if (node.type === 'component') {
                // Match component declarations
                const componentPatterns = [
                    new RegExp(`(function|const)\\s+${node.name}`),
                    new RegExp(`class\\s+${node.name}\\s+extends`),
                ];

                for (const pattern of componentPatterns) {
                    if (pattern.test(line)) {
                        return new vscode.Position(i, 0);
                    }
                }
            }
        }

        // Fallback: use lineNumber from node if available
        if (node.lineNumber !== undefined && node.lineNumber > 0) {
            return new vscode.Position(node.lineNumber - 1, 0);
        }

        return null;
    }

    /**
     * Highlight a specific line
     */
    private async highlightLine(editor: vscode.TextEditor, lineNumber: number): Promise<void> {
        const position = new vscode.Position(lineNumber, 0);
        const range = new vscode.Range(position, position);

        editor.setDecorations(this.highlightDecoration, [range]);

        // Clear highlight after duration
        setTimeout(() => {
            if (editor === this.currentPreviewEditor) {
                editor.setDecorations(this.highlightDecoration, []);
            }
        }, this.config.highlightDuration);
    }

    /**
     * Highlight an entire element
     */
    private async highlightElement(
        editor: vscode.TextEditor,
        startPosition: vscode.Position,
        node: SchemaNode
    ): Promise<void> {
        const document = editor.document;
        let endLine = startPosition.line;

        // Try to find the end of the element
        if (node.endLine !== undefined) {
            endLine = node.endLine - 1;
        } else {
            // Simple heuristic: find closing brace
            const text = document.getText();
            const lines = text.split('\n');
            let braceCount = 0;
            let started = false;

            for (let i = startPosition.line; i < lines.length; i++) {
                const line = lines[i];

                for (const char of line) {
                    if (char === '{') {
                        braceCount++;
                        started = true;
                    } else if (char === '}') {
                        braceCount--;
                        if (started && braceCount === 0) {
                            endLine = i;
                            break;
                        }
                    }
                }

                if (started && braceCount === 0) {
                    break;
                }
            }
        }

        const range = new vscode.Range(
            startPosition,
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );

        editor.setDecorations(this.highlightDecoration, [range]);

        // Clear highlight after duration
        setTimeout(() => {
            if (editor === this.currentPreviewEditor) {
                editor.setDecorations(this.highlightDecoration, []);
            }
        }, this.config.highlightDuration);
    }

    /**
     * Get file path for a node (robust extraction matching FileSystemSyncService)
     */
    private getFilePathForNode(node: SchemaNode): string | null {
        // Walk up to find parent file
        let current: SchemaNode | undefined = node;
        while (current) {
            if (current.type === 'file') {
                return current.path;
            }
            current = current.parent;
        }

        // If node.path contains '#', extract the file path part (e.g., "src/utils.ts#myFunction")
        if (node.path && node.path.includes('#')) {
            const filePath = node.path.split('#')[0];
            return filePath;
        }

        // If node.path looks like a file path, use it directly
        if (node.path && this.isFilePath(node.path)) {
            return node.path;
        }

        return null;
    }

    /**
     * Check if a path looks like a file path
     */
    private isFilePath(pathStr: string): boolean {
        const fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h'];
        return fileExtensions.some(ext => pathStr.endsWith(ext));
    }

    /**
     * Close current preview
     */
    async closePreview(): Promise<void> {
        if (this.currentPreviewEditor) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            this.currentPreviewEditor = undefined;
        }
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<PreviewConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): PreviewConfig {
        return { ...this.config };
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.highlightDecoration.dispose();
    }
}
