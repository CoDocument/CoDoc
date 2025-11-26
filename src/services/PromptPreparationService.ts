/**
 * PromptPreparationService - Prepares comprehensive prompts for OpenCode generation
 * Handles CoDoc structure, changes, history, and context files
 * 
 * Uses StructuralDiffEngine and codocParser for change analysis
 */

import { SchemaNode, StructuralDiff } from '../types.js';
import { structuralDiffEngine } from './StructuralDiffEngine.js';
import { codocParser } from '../parser/codocParser.js';

export interface PromptContext {
  currentCoDocContent: string;
  previousCoDocContent?: string;
  lastGenerationSummary?: string;
  workspaceRoot: string;
}

/**
 * Simplified change representation for prompt building
 */
export interface PromptChange {
  type: 'add' | 'remove' | 'modify' | 'rename';
  element: SchemaNode;
  fromName?: string;
  toName?: string;
}

export class PromptPreparationService {
  /**
   * Prepare complete prompt for OpenCode generation
   */
  async preparePrompt(context: PromptContext): Promise<string> {
    const { currentCoDocContent, previousCoDocContent, lastGenerationSummary } = context;

    // Analyze changes using StructuralDiffEngine if we have previous content
    let changes: PromptChange[] = [];
    if (previousCoDocContent) {
      changes = this.analyzeChanges(previousCoDocContent, currentCoDocContent);
    }

    // Build comprehensive prompt
    const systemPrompt = this.buildSystemPrompt();
    const structureSection = this.buildStructureSection(currentCoDocContent);
    const changesSection = this.buildChangesSection(changes, previousCoDocContent, lastGenerationSummary);
    const implementationGuidelines = this.buildImplementationGuidelines();

    const fullPrompt = `${systemPrompt}

${changesSection}

${structureSection}

${implementationGuidelines}

**CRITICAL REMINDERS**:
- Follow the EXACT CoDoc hierarchy and structure
- Respect parent-child relationships defined by indentation
- Generate COMPLETE, production-ready implementations
- Add comprehensive error handling and validation
- Include TypeScript types and interfaces
- End your response with a ## SUMMARY section describing key changes made`;

    return fullPrompt;
  }

  /**
   * Analyze changes between old and new CoDoc content using StructuralDiffEngine
   */
  private analyzeChanges(oldContent: string, newContent: string): PromptChange[] {
    const changes: PromptChange[] = [];

    try {
      // Parse both contents using codocParser
      const oldParseResult = codocParser.parse(oldContent);
      const newParseResult = codocParser.parse(newContent);

      // Use StructuralDiffEngine to compare
      const diff = structuralDiffEngine.compare(oldParseResult.nodes, newParseResult.nodes);

      // Convert StructuralDiff to PromptChange[]
      for (const added of diff.added) {
        changes.push({ type: 'add', element: added });
      }

      for (const removed of diff.removed) {
        changes.push({ type: 'remove', element: removed });
      }

      for (const modified of diff.modified) {
        changes.push({ type: 'modify', element: modified });
      }

      for (const renamed of diff.renamed) {
        changes.push({
          type: 'rename',
          element: renamed.to,
          fromName: renamed.from.name,
          toName: renamed.to.name
        });
      }
    } catch (error) {
      console.error('Failed to analyze changes:', error);
    }

    return changes;
  }

  /**
   * Build system prompt with core instructions
   */
  private buildSystemPrompt(): string {
    return `You are an expert software architect implementing code changes based on a CoDoc (Collaborative Documentation) specification.

## CODOC STRUCTURE SYNTAX

\`\`\`
/directory          = Directory (folders in the project)
file.ext           = File (source code files)
  %ComponentName   = React component (nested under a file means it belongs to that file)
  $functionName()  = Function (nested under a file means it belongs to that file)
  @reference       = Reference/integration point with existing code
  #note            = Comment/note for context
\`\`\`

## CRITICAL RULES

1. **Hierarchy Respect**: 
   - Elements nested under a file BELONG to that file - add them to that file's content
   - Elements nested under a directory belong in that directory
   - Indentation (2 spaces per level) defines parent-child relationships

2. **File Type Validation**:
   - React components (%) MUST be in .tsx files
   - Functions ($) and types MUST be in .ts files (unless they're React components)
   - NEVER put React components in .ts files

3. **Complete Implementation**:
   - Generate production-ready code with no TODOs or placeholders
   - Include all necessary imports, exports, and type definitions
   - Add comprehensive error handling and validation
   - Follow modern TypeScript/React best practices

4. **Context Awareness**:
   - Respect existing codebase patterns and conventions
   - Integrate smoothly with existing code
   - Maintain consistency in naming, structure, and style`;
  }

  /**
   * Build structure section with current CoDoc content
   */
  private buildStructureSection(currentCoDocContent: string): string {
    return `## CODOC STRUCTURE TO IMPLEMENT

\`\`\`codoc
${currentCoDocContent}
\`\`\`

**IMPLEMENTATION REQUIREMENTS**:
- Implement ALL elements shown in the structure above
- Respect the exact hierarchy and nesting relationships
- Add elements to existing files when they are nested under file entries
- Create new files/directories as explicitly shown in the structure
- Generate supporting code (types, utilities, helpers) as needed for completeness`;
  }

  /**
   * Build changes section highlighting diffs from previous version
   */
  private buildChangesSection(
    changes: PromptChange[],
    previousCoDocContent?: string,
    lastGenerationSummary?: string
  ): string {
    if (!changes.length) {
      return `## INITIAL GENERATION

This is the first generation for this CoDoc. Implement the complete structure from scratch.`;
    }

    const changeDescriptions = changes.map(change => {
      let icon = '🔄';
      if (change.type === 'add') icon = '➕';
      else if (change.type === 'remove') icon = '➖';
      else if (change.type === 'rename') icon = '→';
      
      const typeLabel = change.type.toUpperCase().padEnd(8);
      const elementType = change.element.type.padEnd(10);
      const elementName = change.element.name;
      const location = change.element.path ? ` (${change.element.path})` : '';
      
      let description = `${icon} ${typeLabel} | ${elementType} | ${elementName}${location}`;
      
      // Add rename details if applicable
      if (change.type === 'rename' && change.fromName && change.toName) {
        description += `\n     Renamed: ${change.fromName} → ${change.toName}`;
      }
      
      return description;
    }).join('\n');

    const addedCount = changes.filter(c => c.type === 'add').length;
    const removedCount = changes.filter(c => c.type === 'remove').length;
    const modifiedCount = changes.filter(c => c.type === 'modify').length;
    const renamedCount = changes.filter(c => c.type === 'rename').length;

    const summarySection = lastGenerationSummary 
      ? `\n\n**Last Generation Summary**:\n${lastGenerationSummary}\n` 
      : '';

    const previousSection = previousCoDocContent
      ? `\n\n**Previous CoDoc Version**:\n\`\`\`codoc\n${previousCoDocContent}\n\`\`\`\n`
      : '';

    return `## 🔄 ITERATIVE UPDATE

This is an update to an existing CoDoc. The user has made **${changes.length} changes** since the last generation:
- ${addedCount} additions ➕
- ${modifiedCount} modifications 🔄
- ${removedCount} removals ➖
- ${renamedCount} renames →

### Detailed Changes:

\`\`\`
${changeDescriptions}
\`\`\`
${summarySection}${previousSection}
**IMPORTANT**: 
- Focus on the changed elements - understand WHY they were modified
- Adapt implementation to reflect user's intent behind these changes
- Maintain consistency with existing code while incorporating new requirements
- Consider broader architectural implications of these changes`;
  }

  /**
   * Build implementation guidelines
   */
  private buildImplementationGuidelines(): string {
    return `## IMPLEMENTATION GUIDELINES

### React Components (%)
- Create complete components with comprehensive TypeScript interfaces
- Include proper state management (useState, useReducer, useContext)
- Add effect hooks for lifecycle management
- Implement error boundaries and error handling
- Add accessibility attributes (ARIA roles, labels)
- Include loading and error states
- Optimize with React.memo, useCallback, useMemo as appropriate
- Follow composition patterns

### Functions ($)
- Implement complete business logic with proper types
- Add comprehensive parameter validation
- Include error handling with meaningful error messages
- Create supporting utility functions as needed
- Use async/await patterns for asynchronous operations
- Handle edge cases thoroughly
- Add JSDoc comments for complex functions

### File Structure
- Organize imports: React, third-party, local (in that order)
- Export components/functions appropriately (named or default)
- Define types and interfaces at the top of files
- Group related code together
- Add file-level documentation comments
- Ensure proper module boundaries

### Quality Standards
- Write clean, readable, maintainable code
- Follow DRY (Don't Repeat Yourself) principle
- Use meaningful variable and function names
- Add comments only where code intent isn't obvious
- Handle null/undefined cases
- Validate inputs and outputs
- Consider performance implications`;
  }
}

export const promptPreparationService = new PromptPreparationService();
