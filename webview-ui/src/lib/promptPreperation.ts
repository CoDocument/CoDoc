/**
 * Prompt Preparation - Legacy File
 * 
 * This file previously contained prompt preparation logic for CoDoc code generation.
 * 
 * **MOVED TO**: `src/services/PromptPreparationService.ts` (extension side)
 * 
 * The logic has been relocated to the extension backend where it has:
 * - Better access to codebase analysis (AnalysisEngine)
 * - Direct access to file system operations
 * - Integration with CodeChangeAnalyzer and StructuralDiffEngine
 * - Access to generation history
 * 
 * The webview now focuses solely on:
 * - UI rendering
 * - User interactions
 * - Editor extensions (syntax highlighting, decorations)
 * 
 * This file is kept minimal for backward compatibility.
 */

// Placeholder export (not actively used)
export const LEGACY_PROMPT_NOTE = "Prompt preparation moved to backend service";
