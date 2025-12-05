/**
 * ClaudeCodeService - Claude Agent SDK wrapper for code generation
 * Handles API key-based code generation with streaming progress tracking
 * 
 * KEY EVENTS TRACKED:
 * 1. tool_use (edit/multiedit) - File editing operations
 * 2. tool_use (read) - File read operations
 * 3. text blocks - AI reasoning/thinking
 * 4. assistant messages - Aggregated tool uses and responses
 * 5. result - Final status (success or error)
 */

import * as vscode from 'vscode';
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
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

export class ClaudeCodeService {
    private outputChannel: vscode.OutputChannel;
    private currentQuery: Query | null = null;
    
    // Activity event tracking
    private activityCallbacks: ActivityEventCallbacks | null = null;
    private thinkingBuffer: Map<string, string> = new Map(); // messageId -> accumulated text
    private lastSummary: ParsedSummaryEvent | null = null;
    
    // Session management
    private currentSessionId: string | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Claude Code Activity');
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
     * Initialize Claude Agent SDK (no server required)
     */
    async initialize(): Promise<boolean> {
        try {
            // Try to get API key from VS Code settings first, then fallback to environment variable
            const apiKey = this.getApiKey();
            if (!apiKey) {
                this.log('ANTHROPIC_API_KEY not configured', 'error');
                return false;
            }
            this.log('Claude Agent SDK initialized', 'success');
            return true;
        } catch (error) {
            this.log(`Failed to initialize Claude Agent SDK: ${error}`, 'error');
            return false;
        }
    }

    /**
     * Get Anthropic API key from VS Code settings or environment variable
     * Priority: VS Code User Settings > Environment Variable
     * This ensures users can update the key in settings and it takes effect immediately
     */
    private getApiKey(): string | undefined {
        let sourceUsed = '';
        let finalKey: string | undefined = undefined;
        
        // Try VS Code settings first (PRIORITY - allows real-time updates)
        try {
            const config = vscode.workspace.getConfiguration('codoc');
            const settingsKey = config.get<string>('claudeApiKey');
            
            if (settingsKey && settingsKey.trim().length > 0) {
                finalKey = settingsKey.trim();
                sourceUsed = 'VS Code User Settings';
                
                const keyLength = finalKey.length;
                const keyPreview = keyLength > 10 
                    ? `${finalKey.substring(0, 8)}...${finalKey.substring(keyLength - 4)}`
                    : '(short key)';
                this.log(`✓ Using API key from ${sourceUsed} (length: ${keyLength}, preview: ${keyPreview})`, 'success');
                return finalKey;
            }
        } catch (error) {
            this.log(`⚠ Could not read from VS Code settings: ${error}`, 'info');
        }
        
        // Only fallback to environment variable if VS Code settings is empty
        this.log('⚠ API key not found in VS Code settings, checking environment variable...', 'info');
        const envKey = process.env.ANTHROPIC_API_KEY;
        if (envKey && envKey.trim().length > 0) {
            finalKey = envKey.trim();
            sourceUsed = 'Environment Variable (ANTHROPIC_API_KEY)';
            
            const keyLength = finalKey.length;
            const keyPreview = keyLength > 10 
                ? `${finalKey.substring(0, 8)}...${finalKey.substring(keyLength - 4)}`
                : '(short key)';
            this.log(`⚠ Using API key from ${sourceUsed} (length: ${keyLength}, preview: ${keyPreview})`, 'info');
            this.log(`Note: To use VS Code settings instead, open Settings (Cmd+,) and set codoc.claudeApiKey`, 'info');
            return finalKey;
        }

        this.log('❌ No API key found in VS Code settings or environment variables!', 'error');
        this.log('Please configure your Anthropic API key in VS Code Settings:', 'error');
        this.log('  1. Press Cmd+, to open VS Code Settings', 'error');
        this.log('  2. Search for "codoc.claudeApiKey"', 'error');
        this.log('  3. Paste your API key from https://console.anthropic.com/keys', 'error');
        return undefined;
    }

    /**
     * Ensure Claude Agent SDK is configured
     */
    async ensureServerRunning(): Promise<boolean> {
        const initialized = await this.initialize();
        if (!initialized) {
            const action = await vscode.window.showErrorMessage(
                'Claude Agent SDK not configured. Please set your Anthropic API key.',
                'Open Settings',
                'Show Instructions',
                'Cancel'
            );

            if (action === 'Open Settings') {
                // Open the VS Code settings UI to the codoc.claudeApiKey setting
                await vscode.commands.executeCommand('workbench.action.openSettings', 'codoc.claudeApiKey');
            } else if (action === 'Show Instructions') {
                this.outputChannel.show();
                this.outputChannel.appendLine('=== Claude Agent SDK Setup ===');
                this.outputChannel.appendLine('');
                this.outputChannel.appendLine('Option 1: VS Code Settings (Recommended)');
                this.outputChannel.appendLine('  1. Open VS Code Settings (Cmd+,)');
                this.outputChannel.appendLine('  2. Search for "codoc.claudeApiKey"');
                this.outputChannel.appendLine('  3. Paste your API key from https://console.anthropic.com');
                this.outputChannel.appendLine('  4. Click the Generate button again');
                this.outputChannel.appendLine('');
                this.outputChannel.appendLine('Option 2: Environment Variable');
                this.outputChannel.appendLine('  1. Get an API key from https://console.anthropic.com');
                this.outputChannel.appendLine('  2. Run: export ANTHROPIC_API_KEY=sk-ant-xxxxx...');
                this.outputChannel.appendLine('  3. Restart VS Code');
                this.outputChannel.appendLine('  4. Try generating code again');
            }
            return false;
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
            return { success: false, error: 'Claude Agent SDK not configured' };
        }

        try {
            this.outputChannel.show(true);
            onProgress({ stage: 'starting', message: 'Initializing generation...' });

            this.log(`Starting generation with Claude Agent SDK`, 'info');
            onProgress({ stage: 'thinking', message: 'Claude is processing your request...' });

            // Ensure API key is set in environment for Claude Agent SDK
            const apiKey = this.getApiKey();
            if (!apiKey) {
                throw new Error('API key not found - cannot initialize Claude Agent SDK');
            }
            this.log(`Setting ANTHROPIC_API_KEY environment variable (length: ${apiKey.length})`, 'info');
            process.env.ANTHROPIC_API_KEY = apiKey; // Set for SDK to use
            this.log(`Environment variable set. About to call query() with apiKey configured`, 'info');

            // Use Claude Agent SDK query function with Claude Code system prompt for automatic planning
            // This enables Claude to automatically: plan → read files → edit → diff → summarize
            const messageStream = query({
                prompt,
                options: {
                    model: 'claude-haiku-4-5', // Use Claude Haiku 4.5 for faster, cost-effective generation
                    cwd: workDir,
                    // Resume session if available to preserve context
                    ...(this.currentSessionId ? { resume: this.currentSessionId } : {}),
                    // Allow all available tools for maximum flexibility
                    // Claude will use: Read, Write, Edit, MultiEdit, Bash, Glob, Grep, Search, WebFetch, WebSearch, and more
                    // Note: not specifying allowedTools allows all tools by default
                    // permissionMode options: 'default' (ask before each action), 
                    // 'acceptEdits' (auto-accept file edits), 'bypassPermissions' (auto-accept all)
                    permissionMode: 'acceptEdits', // Auto-accept file edits for streamlined workflow
                    // Load Claude Code system prompt to enable automatic planning and multi-step tool use
                    // This makes Claude behave like Claude Code desktop: auto-plan, auto-read, auto-edit, auto-diff
                    systemPrompt: {
                        type: 'preset',
                        preset: 'claude_code',
                        // Append user prompt context to system prompt for complete task definition
                        // This ensures Claude understands the full scope of what needs to be done
                        append: `\n\nTASK CONTEXT:\n${prompt}\n\nBased on the above task, automatically plan, execute, and complete all necessary changes.`
                    }
                }
            });
            
            this.currentQuery = messageStream;

            // Process streaming messages
            await this.processEventsStream(messageStream, onProgress, onFileChange);

            this.log(`Generation completed successfully`, 'success');
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Generation failed: ${errorMsg}`, 'error');
            onProgress({ stage: 'error', message: errorMsg });
            return { success: false, error: errorMsg };
        } finally {
            this.currentQuery = null;
        }
    }

    /**
     * Process Claude Agent SDK message stream in real-time
     * Mirrors OpenCode behavior: routes to typed event handlers using switch pattern
     */
    private async processEventsStream(
        stream: AsyncIterable<any>,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): Promise<void> {
        try {
            const fileChanges: Set<string> = new Set();
            const toolTracker: Map<string, any> = new Map(); // Track tool_use by id
            const editDiffs: FileDiff[] = []; // Aggregate diffs from all edit tools
            let hasProcessedMessages = false;

            for await (const message of stream) {
                hasProcessedMessages = true;
                const type = message.type;

                // =====================
                // ROUTE TO EVENT HANDLERS
                // =====================
                
                // Log message type for debugging
                this.log(`Processing message type: ${type}`, 'info');
                
                // Handle result messages (success or error completion)
                if (type === 'result') {
                    const subtype = (message as any).subtype;
                    if (subtype === 'success') {
                        this.log(`Generation completed with success`, 'success');
                    } else if (subtype?.includes('error')) {
                        const errors = (message as any).errors || [];
                        const errorMsg = errors.length > 0 ? errors[0] : 'Unknown error during generation';
                        this.log(`Generation error (${subtype}): ${errorMsg}`, 'error');
                        throw new Error(`Generation failed: ${errorMsg}`);
                    }
                    // Result message ends the stream - exit loop
                    return;
                }
                
                // Handle assistant messages (contains tool uses and text from Claude)
                if (type === 'assistant') {
                    const apiMessage = (message as any).message;
                    if (apiMessage && apiMessage.content) {
                        const content = Array.isArray(apiMessage.content) ? apiMessage.content : [];
                        this.log(`Processing assistant message with ${content.length} content blocks`, 'info');
                        
                        for (const block of content) {
                            if (!block) continue;
                            
                            const blockType = block.type;
                            this.log(`  - Content block type: ${blockType}`, 'info');
                            
                            // Handle tool_use blocks (file edits, reads, etc)
                            if (blockType === 'tool_use') {
                                const toolId = block.id || '';
                                const toolName = block.name || '';
                                const input = block.input || {};
                                
                                this.log(`    Tool: ${toolName} (id: ${toolId})`, 'info');
                                
                                // Track this tool use
                                toolTracker.set(toolId, { toolName, input, status: 'pending' });
                                
                                // Handle pending state
                                this.handleMessagePartUpdated({
                                    part: { id: toolId, type: 'tool', tool: toolName.toLowerCase() },
                                    state: { status: 'pending', input }
                                }, onProgress, onFileChange, toolTracker, fileChanges);
                                
                                // Transition to running state
                                toolTracker.get(toolId).status = 'running';
                                this.handleMessagePartUpdated({
                                    part: { id: toolId, type: 'tool', tool: toolName.toLowerCase() },
                                    state: { status: 'running', input }
                                }, onProgress, onFileChange, toolTracker, fileChanges);
                                
                                // Mark as completed (since we don't have separate tool_result in this message)
                                toolTracker.get(toolId).status = 'completed';
                                this.handleMessagePartUpdated({
                                    part: { id: toolId, type: 'tool', tool: toolName.toLowerCase() },
                                    state: { status: 'completed', input }
                                }, onProgress, onFileChange, toolTracker, fileChanges);
                                
                                // Track file changes
                                if ((toolName.toLowerCase() === 'edit' || toolName.toLowerCase() === 'multiedit') && input?.path) {
                                    fileChanges.add(input.path);
                                    editDiffs.push({
                                        file: input.path,
                                        before: '',
                                        after: '',
                                        additions: 1,
                                        deletions: 0
                                    });
                                    this.log(`    File modified: ${input.path}`, 'info');
                                }
                            }
                            // Handle text blocks (reasoning)
                            else if (blockType === 'text') {
                                this.log(`    Text: ${(block.text || '').substring(0, 50)}...`, 'info');
                                this.handleMessagePartUpdated(
                                    { part: block, state: {} },
                                    onProgress,
                                    onFileChange,
                                    toolTracker,
                                    fileChanges
                                );
                            }
                        }
                    }
                }
                
                // Handle system messages (session initialization, status, etc)
                if (type === 'system') {
                    const subtype = (message as any).subtype;
                    if (subtype === 'init' && (message as any).session_id) {
                        const props = { sessionId: (message as any).session_id };
                        this.handleSessionStatus(props, onProgress);
                    } else if (subtype === 'status') {
                        const status = (message as any).status;
                        if (status) {
                            this.log(`Session status: ${status}`, 'info');
                            onProgress({ stage: 'thinking', message: `Processing... (${status})` });
                        }
                    } else if (subtype === 'compact_boundary') {
                        this.log(`Session compacting...`, 'info');
                    }
                    // Continue processing other system messages
                }
                
                // Handle tool_progress messages (for real-time progress updates)
                if (type === 'tool_progress') {
                    const toolName = (message as any).tool_name || 'unknown';
                    const elapsed = (message as any).elapsed_time_seconds || 0;
                    this.log(`Tool progress: ${toolName} (${elapsed}s)`, 'info');
                    onProgress({ stage: 'editing', message: `Executing ${toolName}...` });
                }
            }

            // =====================
            // GENERATION COMPLETE - Aggregate and emit final events
            // =====================
            
            // Emit aggregated diff summary (session.diff event)
            if (editDiffs.length > 0) {
                this.handleSessionDiff(
                    { diff: editDiffs },
                    onProgress
                );
            }
            
            // Emit final summary (message.updated event)
            if (fileChanges.size > 0) {
                this.handleMessageUpdated(
                    {
                        info: {
                            id: generateEventId(),
                            summary: {
                                title: `${fileChanges.size} files modified`,
                                body: `Generated changes affecting ${fileChanges.size} file(s)`,
                                diffs: editDiffs
                            }
                        }
                    },
                    onProgress
                );
            }
            
            // Emit session idle (stream complete)
            onProgress({ stage: 'complete', message: 'Code generation finished!' });
            this.emitActivityEvent({
                id: generateEventId(),
                type: 'complete',
                timestamp: Date.now(),
                message: 'Complete'
            });
            
            this.activityCallbacks?.onComplete();
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Stream processing error: ${errorMsg}`, 'error');
            onProgress({ stage: 'error', message: errorMsg });
            this.activityCallbacks?.onError(errorMsg);
        }
    }

    /**
     * Handle message.part.updated events
     * Routes to appropriate handler based on part type
     */
    private handleMessagePartUpdated(
        props: any,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void,
        toolTracker?: Map<string, any>,
        fileChanges?: Set<string>
    ): void {
        const part = props.part;
        if (!part) return;

        const partType = part.type;
        const tool = part.tool;
        const state = props.state;

        // EDIT TOOL - File is being edited
        if (partType === 'tool' && (tool === 'edit' || tool === 'multiedit')) {
            this.handleEditTool(part, state, onProgress, onFileChange);
            // Track file changes on completion
            if (state?.status === 'completed' && fileChanges) {
                const filePath = state?.input?.path || state?.input?.filePath || '';
                if (filePath) {
                    fileChanges.add(filePath);
                }
            }
        }
        // READ TOOL - File is being read
        else if (partType === 'tool' && tool === 'read') {
            this.handleReadTool(part, state, onProgress);
        }
        // TEXT - AI reasoning/thinking (streaming)
        else if (partType === 'text') {
            this.handleThinkingText(part, onProgress);
        }
    }

    /**
     * Handle edit tool state transitions (mirroring OpenCode behavior)
     */
    private handleEditTool(
        part: any,
        state: any,
        onProgress: (progress: GenerationProgress) => void,
        onFileChange: (change: FileChangeEvent) => void
    ): void {
        const status = state?.status;
        const input = state?.input || {};
        const filePath = input.path || input.filePath || '';
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
        } else if (status === 'running') {
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
        } else if (status === 'completed') {
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

            this.emitGutterDecoration({
                id: `gutter_${part.id}`,
                lineNumber: -1,
                iconType: 'edit',
                tooltip: `Edited: +${additions} -${deletions}`,
                filePath,
                additions,
                deletions
            });

            onFileChange({
                path: filePath,
                type: 'modified',
                timestamp: Date.now()
            });
        }
    }

    /**
     * Handle read tool state transitions (mirroring OpenCode behavior)
     */
    private handleReadTool(
        part: any,
        state: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const status = state?.status;
        const input = state?.input || {};
        const filePath = input.path || input.filePath || '';
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
        } else if (status === 'completed') {
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
     * Handle thinking/reasoning text (mirroring OpenCode behavior)
     */
    private handleThinkingText(
        part: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const currentText = part.text || '';
        const partId = part.id || `thinking_${Date.now()}`;

        // Accumulate text for this message
        this.thinkingBuffer.set(partId, currentText);

        // Only emit if we have meaningful content
        if (currentText.length > 10) {
            const truncated = currentText.length > 60
                ? currentText.slice(0, 57) + '...'
                : currentText;

            onProgress({ stage: 'thinking', message: truncated });

            // Emit activity event
            this.emitActivityEvent({
                id: partId,
                type: 'thinking',
                timestamp: Date.now(),
                message: `Thinking: ${truncated}`,
                details: currentText
            });
        }
    }

    /**
     * Handle file.edited events - file write operations
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
     * Handle session.diff events - aggregated file changes
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
            raw: { fileCount: diffs.length }
        });
    }

    /**
     * Handle message.updated events - final generation summary
     */
    private handleMessageUpdated(
        props: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const info = props.info;
        if (!info || !info.summary) return;

        const summary = info.summary;
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
            message: summary.title,
            details: summary.body
        });
    }

    /**
     * Handle session.status events - session initialization and status updates
     */
    private handleSessionStatus(
        props: any,
        onProgress: (progress: GenerationProgress) => void
    ): void {
        const sessionId = props.sessionId;
        if (sessionId) {
            this.currentSessionId = sessionId;
            this.log(`Session initialized: ${sessionId}`, 'info');
            this.emitActivityEvent({
                id: generateEventId(),
                type: 'complete',
                timestamp: Date.now(),
                message: `Session started`,
                details: sessionId
            });
        }
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
     * Interrupt the active Claude Agent query if one is running
     */
    async stopGeneration(): Promise<boolean> {
        if (!this.currentQuery) {
            return false;
        }

        try {
            this.log('Interrupting Claude Agent session...', 'info');
            if (typeof this.currentQuery.interrupt === 'function') {
                await this.currentQuery.interrupt();
            }

            if (typeof this.currentQuery.return === 'function') {
                await this.currentQuery.return();
            }

            this.currentQuery = null;
            this.log('Claude Agent session interrupted successfully', 'success');
            return true;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Failed to interrupt Claude Agent session: ${errorMsg}`, 'error');
            return false;
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}

export const claudeCodeService = new ClaudeCodeService();
