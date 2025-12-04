/**
 * OpenCodeSDKService - SDK-based wrapper for OpenCode integration
 * Handles real-time event streaming, file change detection, and progress tracking
 * 
 * KEY EVENTS TRACKED:
 * 1. EDIT (file.edited + message.part.updated with tool="edit")
 * 2. DIFF (session.diff) - finalized file changes
 * 3. SUMMARY (message.updated with summary) - final generation summary
 * 4. READ (message.part.updated with tool="read")
 * 5. REASONING (message.part.updated with type="text") - streaming text
 */

import * as vscode from 'vscode';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { 
    ActivityEvent, 
    ActivityEventCallbacks, 
    GutterDecoration,
    ParsedEditEvent,
    ParsedReadEvent,
    ParsedDiffEvent,
    ParsedSummaryEvent,
    ParsedThinkingEvent,
    generateEventId,
    extractFileName,
    createActivityMessage
} from './ActivityEventTypes.js';
import { FileDiff } from '../../types.js';

type OpencodeClient = any;

export interface GenerationProgress {
    stage: 'starting' | 'thinking' | 'editing' | 'executing' | 'complete' | 'error';
    message: string;
    fileChanges?: string[];
    details?: {
        sessionId?: string;
        messageId?: string;
        tool?: string;
        content?: string;
    };
}

export interface FileChangeEvent {
    path: string;
    type: 'created' | 'modified' | 'deleted';
    timestamp: number;
    content?: string;
}

export class OpenCodeSDKService {
    private client: OpencodeClient | null = null;
    private outputChannel: vscode.OutputChannel;
    private currentSessionId: string | null = null;
    private isServerRunning: boolean = false;
    
    // Activity event tracking
    private activityCallbacks: ActivityEventCallbacks | null = null;
    private thinkingBuffer: Map<string, string> = new Map(); // messageId -> accumulated text
    private lastSummary: ParsedSummaryEvent | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('OpenCode Activity');
    }

    /**
     * Set callbacks for activity events
     */
    setActivityCallbacks(callbacks: ActivityEventCallbacks): void {
        this.activityCallbacks = callbacks;
    }

    /**
     * Get the last generation summary
     */
    getLastSummary(): ParsedSummaryEvent | null {
        return this.lastSummary;
    }

    /**
     * Initialize OpenCode client
     */
    async initialize(): Promise<boolean> {
        if (this.client) {
            return true;
        }

        try {
            this.client = createOpencodeClient({
                baseUrl: 'http://127.0.0.1:4096'
            });

            // Test connection
            await this.testConnection();
            this.isServerRunning = true;
            return true;
        } catch (error) {
            this.log(`Failed to connect to OpenCode server: ${error}`, 'error');
            return false;
        }
    }

    /**
     * Test if OpenCode server is accessible
     */
    private async testConnection(): Promise<void> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        try {
            // Try to get current path as a connection test
            await this.client.path.get();
        } catch (error) {
            throw new Error(`OpenCode server not responding. Please run 'opencode serve' first.`);
        }
    }

    /**
     * Ensure server is running, show helpful error if not
     */
    async ensureServerRunning(): Promise<boolean> {
        if (!this.isServerRunning) {
            const connected = await this.initialize();
            if (!connected) {
                const action = await vscode.window.showErrorMessage(
                    'OpenCode server is not running. Please start it with "opencode serve" in your terminal.',
                    'Show Instructions',
                    'Cancel'
                );

                if (action === 'Show Instructions') {
                    this.outputChannel.show();
                    this.outputChannel.appendLine('=== OpenCode Server Setup ===');
                    this.outputChannel.appendLine('1. Open a terminal in your project root');
                    this.outputChannel.appendLine('2. Run: opencode serve -p 4096 127.0.0.1');
                    this.outputChannel.appendLine('3. Wait for server to start');
                    this.outputChannel.appendLine('4. Try generating code again');
                }
                return false;
            }
        }
        return true;
    }

    /**
     * Generate code with real-time progress tracking
     */
    async generate(
        prompt: string,
        workDir: string,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): Promise<{ success: boolean; error?: string }> {
        if (!await this.ensureServerRunning()) {
            return { success: false, error: 'OpenCode server not running' };
        }

        if (!this.client) {
            return { success: false, error: 'Client not initialized' };
        }

        try {
            this.outputChannel.show(true);
            onProgress({ stage: 'starting', message: 'Initializing generation...' });

            // Create a new session
            const sessionResponse = await this.client.session.create({
                body: {
                    title: 'CoDoc Generation'
                }
            });

            this.currentSessionId = sessionResponse.data.id;
            this.log(`Session created: ${this.currentSessionId}`, 'info');
            // const config = await this.client.config.get();
            // const { providers, default: defaults } = await this.client.config.providers();

            const eventSubscription = await this.client.event.subscribe();            
            this.processEventsStream(eventSubscription.stream, onProgress, onFileChange);
            
            const messageResponse = await this.client.session.prompt({
                path: { id: this.currentSessionId },
                body: {
                    parts: [{ type: 'text', text: prompt }]
                }
            });

            if (!messageResponse.data) {
                throw new Error('Failed to send message');
            }

            this.log(`Message sent successfully (ID: ${messageResponse.data.id})`, 'success');
            onProgress({ stage: 'thinking', message: 'AI is processing your request...' });

            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Generation failed: ${errorMsg}`, 'error');
            onProgress({ stage: 'error', message: errorMsg });
            return { success: false, error: errorMsg };
        }
    }

    /**
     * Process server-sent events stream in real-time
     * FOCUSED ON KEY EVENTS ONLY:
     * 1. message.part.updated (tool=edit) - File edits
     * 2. message.part.updated (tool=read) - File reads
     * 3. message.part.updated (type=text) - AI reasoning/thinking
     * 4. file.edited - File was edited
     * 5. session.diff - Finalized diffs
     * 6. message.updated - Final summary with diffs
     * 7. session.idle - Generation complete
     */
    private async processEventsStream(
        stream: AsyncIterable<any>,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): Promise<void> {
        try {
            for await (const event of stream) {
                const eventType = event.type;
                const props = event.properties || {};

                switch (eventType) {
                    // =====================
                    // KEY EVENT 1: EDIT TOOL
                    // =====================
                    case 'message.part.updated':
                        this.handleMessagePartUpdated(props, onProgress, onFileChange);
                        break;

                    // =====================
                    // KEY EVENT 2: FILE EDITED
                    // =====================
                    case 'file.edited':
                        this.handleFileEdited(props, onFileChange);
                        break;

                    // =====================
                    // KEY EVENT 3: SESSION DIFF
                    // =====================
                    case 'session.diff':
                        this.handleSessionDiff(props, onProgress);
                        break;

                    // =====================
                    // KEY EVENT 4: FINAL SUMMARY
                    // =====================
                    case 'message.updated':
                        this.handleMessageUpdated(props, onProgress);
                        break;

                    // =====================
                    // SESSION STATUS EVENTS
                    // =====================
                    case 'session.status':
                        this.handleSessionStatus(props, onProgress);
                        break;

                    case 'session.idle':
                        onProgress({ stage: 'complete', message: 'Code generation finished!' });
                        this.emitActivityEvent({
                            id: generateEventId(),
                            type: 'complete',
                            timestamp: Date.now(),
                            message: 'Complete'
                        });
                        this.activityCallbacks?.onComplete();
                        break;

                    case 'session.error':
                        const errorMsg = props.error?.data?.message || 'An error occurred';
                        onProgress({ stage: 'error', message: errorMsg });
                        this.activityCallbacks?.onError(errorMsg);
                        break;

                    // Ignore other events
                    default:
                        break;
                }
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.activityCallbacks?.onError(errorMsg);
        }
    }

    /**
     * Handle message.part.updated events
     * This includes: edit tool, read tool, and text (thinking) events
     */
    private handleMessagePartUpdated(
        props: any, 
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): void {
        const part = props.part;
        if (!part) return;

        const partType = part.type;
        const tool = part.tool;
        const state = part.state;

        // EDIT TOOL - File is being edited
        if (partType === 'tool' && tool === 'edit') {
            this.handleEditTool(part, state, onProgress, onFileChange);
        }
        // READ TOOL - File is being read
        else if (partType === 'tool' && tool === 'read') {
            this.handleReadTool(part, state, onProgress);
        }
        // TEXT - AI reasoning/thinking (streaming)
        else if (partType === 'text') {
            this.handleThinkingText(part, props.delta, onProgress);
        }
    }

    /**
     * Handle edit tool events
     */
    private handleEditTool(
        part: any, 
        state: any,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): void {
        const status = state?.status;
        const input = state?.input || {};
        const filePath = input.filePath || '';
        const fileName = extractFileName(filePath);

        if (status === 'pending') {
            this.emitActivityEvent({
                id: part.id,
                type: 'editing',
                timestamp: Date.now(),
                message: `Editing ${fileName}...`,
                filePath,
                fileName,
                toolName: 'edit',
                toolStatus: 'pending'
            });
        }
        else if (status === 'running') {
            onProgress({ stage: 'editing', message: `Editing ${fileName}...` });
            this.emitActivityEvent({
                id: part.id,
                type: 'editing',
                timestamp: Date.now(),
                message: `Editing ${fileName}...`,
                filePath,
                fileName,
                toolName: 'edit',
                toolStatus: 'running'
            });
        }
        else if (status === 'completed') {
            const metadata = state.metadata || {};
            const filediff = metadata.filediff || {};
            const additions = filediff.additions || 0;
            const deletions = filediff.deletions || 0;

            onProgress({ 
                stage: 'editing', 
                message: `Edited ${fileName} (+${additions} -${deletions})`,
                fileChanges: [filePath]
            });

            this.emitActivityEvent({
                id: part.id,
                type: 'editing',
                timestamp: Date.now(),
                message: `Edited ${fileName}`,
                details: `+${additions} -${deletions}`,
                filePath,
                fileName,
                additions,
                deletions,
                toolName: 'edit',
                toolStatus: 'completed'
            });

            // Emit gutter decoration
            this.emitGutterDecoration({
                id: `gutter_${part.id}`,
                lineNumber: -1, // Will be resolved by matching filePath
                iconType: 'edit',
                tooltip: `Edited: +${additions} -${deletions}`,
                filePath,
                additions,
                deletions
            });

            // Trigger file change callback
            onFileChange({
                path: filePath,
                type: 'modified',
                timestamp: Date.now()
            });
        }
    }

    /**
     * Handle read tool events
     */
    private handleReadTool(
        part: any, 
        state: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const status = state?.status;
        const input = state?.input || {};
        const filePath = input.filePath || '';
        const fileName = extractFileName(filePath);

        if (status === 'running' || status === 'pending') {
            onProgress({ stage: 'thinking', message: `Reading ${fileName}...` });
            this.emitActivityEvent({
                id: part.id,
                type: 'reading',
                timestamp: Date.now(),
                message: `Reading ${fileName}...`,
                filePath,
                fileName,
                toolName: 'read',
                toolStatus: status
            });
        }
        else if (status === 'completed') {
            this.emitActivityEvent({
                id: part.id,
                type: 'reading',
                timestamp: Date.now(),
                message: `Read ${fileName}`,
                filePath,
                fileName,
                toolName: 'read',
                toolStatus: 'completed'
            });

            // Emit gutter decoration for read
            this.emitGutterDecoration({
                id: `gutter_${part.id}`,
                lineNumber: -1,
                iconType: 'read',
                tooltip: `Read file`,
                filePath
            });
        }
    }

    /**
     * Handle streaming text (AI thinking/reasoning)
     */
    private handleThinkingText(
        part: any, 
        delta: string | undefined,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const messageId = part.messageID;
        const currentText = part.text || '';

        // Accumulate text for this message
        this.thinkingBuffer.set(messageId, currentText);

        // Only emit if we have meaningful content
        if (currentText.length > 10) {
            const truncated = currentText.length > 60 
                ? currentText.slice(0, 57) + '...' 
                : currentText;

            onProgress({ stage: 'thinking', message: truncated });
            
            // Emit activity event (throttled to avoid spam)
            this.emitActivityEvent({
                id: `thinking_${messageId}`,
                type: 'thinking',
                timestamp: Date.now(),
                message: `Thinking: ${truncated}`,
                details: currentText
            });
        }
    }

    /**
     * Handle file.edited events
     */
    private handleFileEdited(
        props: any,
        onFileChange: (change: FileChangeEvent) => void
    ): void {
        const filePath = props.file || '';
        const fileName = extractFileName(filePath);

        this.emitActivityEvent({
            id: generateEventId(),
            type: 'editing',
            timestamp: Date.now(),
            message: `File saved: ${fileName}`,
            filePath,
            fileName
        });

        onFileChange({
            path: filePath,
            type: 'modified',
            timestamp: Date.now()
        });
    }

    /**
     * Handle session.diff events - finalized file changes
     */
    private handleSessionDiff(
        props: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const diffs: FileDiff[] = props.diff || [];
        
        let totalAdditions = 0;
        let totalDeletions = 0;
        const changedFiles: string[] = [];

        for (const diff of diffs) {
            totalAdditions += diff.additions || 0;
            totalDeletions += diff.deletions || 0;
            changedFiles.push(diff.file);

            // Emit gutter decoration for each file
            this.emitGutterDecoration({
                id: `diff_${generateEventId()}`,
                lineNumber: -1,
                iconType: 'edit',
                tooltip: `+${diff.additions} -${diff.deletions}`,
                filePath: diff.file,
                additions: diff.additions,
                deletions: diff.deletions
            });
        }

        const message = `${diffs.length} files: +${totalAdditions} -${totalDeletions}`;
        onProgress({ 
            stage: 'editing', 
            message,
            fileChanges: changedFiles
        });

        this.emitActivityEvent({
            id: generateEventId(),
            type: 'diff',
            timestamp: Date.now(),
            message,
            additions: totalAdditions,
            deletions: totalDeletions,
            raw: diffs
        });
    }

    /**
     * Handle message.updated events - contains final summary
     */
    private handleMessageUpdated(
        props: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const info = props.info;
        if (!info || info.role !== 'user') return;

        const summary = info.summary;
        if (!summary) return;

        const parsedSummary: ParsedSummaryEvent = {
            messageId: info.id,
            sessionId: info.sessionID,
            title: summary.title,
            body: summary.body,
            diffs: summary.diffs || [],
            model: {
                providerId: info.model?.providerID || '',
                modelId: info.model?.modelID || ''
            }
        };

        // Store for later retrieval
        this.lastSummary = parsedSummary;

        onProgress({ 
            stage: 'complete', 
            message: summary.title || 'Generation complete'
        });

        this.emitActivityEvent({
            id: generateEventId(),
            type: 'summary',
            timestamp: Date.now(),
            message: summary.title || 'Generation complete',
            details: summary.body,
            raw: parsedSummary
        });

        this.activityCallbacks?.onSummary(parsedSummary);
    }

    /**
     * Emit activity event to callbacks
     */
    private emitActivityEvent(event: ActivityEvent): void {
        this.activityCallbacks?.onActivity(event);
    }

    /**
     * Emit gutter decoration to callbacks
     */
    private emitGutterDecoration(decoration: GutterDecoration): void {
        this.activityCallbacks?.onGutterDecoration(decoration);
    }

    /**
     * Handle session status updates
     */
    private handleSessionStatus(props: any, onProgress: (progress: GenerationProgress) => void): void {
        const status = props.status?.type || props.type;

        switch (status) {
            case 'idle':
                onProgress({ stage: 'complete', message: 'Generation complete!' });
                break;
            case 'busy':
                onProgress({ stage: 'executing', message: 'Working...' });
                break;
            case 'retry':
                onProgress({ stage: 'thinking', message: `Retrying...` });
                break;
        }
    }

    /**
     * Get session details
     */
    async getSessionDetails(sessionId: string): Promise<any> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        const response = await this.client.session.get({
            path: { id: sessionId }
        });

        return response.data;
    }

    /**
     * Get session messages
     */
    async getSessionMessages(sessionId: string): Promise<any[]> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        const response = await this.client.session.messages({
            path: { id: sessionId }
        });

        return response.data || [];
    }

    /**
     * Get file status for tracking changes
     * Useful for feedback pipeline to detect what files were modified
     */
    async getFileStatus(): Promise<any[]> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        try {
            const response = await this.client.file.status({});
            this.log(`File status: ${response.data?.length || 0} tracked files`, 'info');
            return response.data || [];
        } catch (error) {
            this.log(`Failed to get file status: ${error}`, 'error');
            return [];
        }
    }

    /**
     * Search for files in workspace (useful for CoDoc processing)
     */
    async findFiles(pattern: string): Promise<string[]> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        try {
            const response = await this.client.find.files({
                query: { query: pattern }
            });
            return response.data || [];
        } catch (error) {
            this.log(`Failed to find files: ${error}`, 'error');
            return [];
        }
    }

    /**
     * Read file content
     */
    async readFile(filePath: string): Promise<string | null> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        try {
            const response = await this.client.file.read({
                query: { path: filePath }
            });
            return response.data?.content || null;
        } catch (error) {
            this.log(`Failed to read file ${filePath}: ${error}`, 'error');
            return null;
        }
    }

    /**
     * Abort current generation session
     */
    async abortGeneration(): Promise<boolean> {
        if (!this.client || !this.currentSessionId) {
            return false;
        }

        try {
            this.log('Aborting generation...', 'info');
            await this.client.session.abort({
                path: { id: this.currentSessionId }
            });
            this.log('Generation aborted successfully', 'success');
            return true;
        } catch (error) {
            this.log(`Failed to abort generation: ${error}`, 'error');
            return false;
        }
    }

    /**
     * Get current session status
     */
    async getCurrentSessionStatus(): Promise<any> {
        if (!this.client || !this.currentSessionId) {
            return null;
        }

        try {
            const response = await this.client.session.get({
                path: { id: this.currentSessionId }
            });
            return response.data;
        } catch (error) {
            this.log(`Failed to get session status: ${error}`, 'error');
            return null;
        }
    }

    /**
     * Log messages to output channel
     */
    private log(message: string, level: 'info' | 'error' | 'success' | 'stream' | 'file' = 'info'): void {
        const timestamp = new Date().toLocaleTimeString();
        let prefix = '';

        switch (level) {
            case 'error':
                prefix = '[ERROR]';
                break;
            case 'success':
                prefix = '[SUCCESS]';
                break;
            case 'stream':
                prefix = '[AI]';
                break;
            case 'file':
                prefix = '[FILE]';
                break;
            default:
                prefix = '[INFO]';
        }

        this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputChannel.show();
    }

    /**
     * Clear output channel
     */
    clearOutput(): void {
        this.outputChannel.clear();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}

export const openCodeSDKService = new OpenCodeSDKService();
