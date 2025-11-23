/**
 * ImpactAnalysisService - Edit-driven feedforward using OpenAI API
 * Analyzes dependency impact when user edits CODOC nodes
 */

import { SchemaNode, DependencyGraph, SuggestedChange, ImpactAnalysis } from '../types';

export class ImpactAnalysisService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 1800; // 1.8 seconds

  /**
   * Analyze impact of editing a CODOC node
   * Debounced to avoid excessive API calls
   */
  analyzeEditImpact(
    editedNode: SchemaNode,
    dependencyGraph: DependencyGraph,
    lastGenerationSummary: string,
    apiKey: string,
    onSuggestions?: (suggestions: SuggestedChange[]) => void
  ): void {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Check if node has dependencies
    const hasDependencies = editedNode.dependencies && editedNode.dependencies.length > 0;
    const hasDependents = editedNode.dependents && editedNode.dependents.length > 0;

    if (!hasDependencies && !hasDependents) {
      // No dependencies - skip analysis
      return;
    }

    // Debounce analysis
    this.debounceTimer = setTimeout(async () => {
      try {
        const analysis = await this.performAnalysis(
          editedNode,
          dependencyGraph,
          lastGenerationSummary,
          apiKey
        );

        if (onSuggestions && analysis.suggestions.length > 0) {
          onSuggestions(analysis.suggestions);
        }
      } catch (error) {
        console.error('Impact analysis failed:', error);
      }
    }, this.DEBOUNCE_MS);
  }

  /**
   * Perform actual impact analysis using OpenAI
   */
  private async performAnalysis(
    editedNode: SchemaNode,
    dependencyGraph: DependencyGraph,
    lastGenerationSummary: string,
    apiKey: string
  ): Promise<ImpactAnalysis> {
    // Build context about dependencies
    const upstreamContext = this.buildDependencyContext(
      editedNode.dependencies || [],
      dependencyGraph,
      'upstream'
    );
    const downstreamContext = this.buildDependencyContext(
      editedNode.dependents || [],
      dependencyGraph,
      'downstream'
    );

    // Build prompt
    const prompt = this.buildAnalysisPrompt(
      editedNode,
      upstreamContext,
      downstreamContext,
      lastGenerationSummary
    );

    // Call OpenAI
    const response = await this.callOpenAI(prompt, apiKey);

    // Parse suggestions
    const suggestions = this.parseSuggestions(response);

    return {
      editedNode: editedNode.path,
      affectedNodes: [...(editedNode.dependencies || []), ...(editedNode.dependents || [])],
      suggestions,
      reasoning: response
    };
  }

  /**
   * Build context about dependencies
   */
  private buildDependencyContext(
    dependencies: string[],
    graph: DependencyGraph,
    type: 'upstream' | 'downstream'
  ): string {
    if (dependencies.length === 0) {
      return `No ${type} dependencies.`;
    }

    const lines: string[] = [`${type.toUpperCase()} DEPENDENCIES:`];

    for (const dep of dependencies) {
      const node = graph.nodes[dep];
      if (node) {
        lines.push(`  - ${dep} (${node.type})`);
        if (type === 'upstream' && node.upstream.length > 0) {
          lines.push(`    imports: ${node.upstream.join(', ')}`);
        }
        if (type === 'downstream' && node.downstream.length > 0) {
          lines.push(`    used by: ${node.downstream.join(', ')}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Build analysis prompt for OpenAI
   */
  private buildAnalysisPrompt(
    editedNode: SchemaNode,
    upstreamContext: string,
    downstreamContext: string,
    lastSummary: string
  ): string {
    return `You are analyzing the impact of a user editing a CODOC structure element.

EDITED NODE:
Type: ${editedNode.type}
Path: ${editedNode.path}
Name: ${editedNode.name}

${upstreamContext}

${downstreamContext}

LAST GENERATION SUMMARY:
${lastSummary}

TASK: Based on the edited node and its dependencies, suggest what CODOC structural changes the user might need to make next. Consider:
1. Upstream dependencies - if the user added/removed dependencies, they may need to add corresponding imports or function calls
2. Downstream dependents - if the user modified a widely-used function, they may need to update call sites
3. Recent generation context - align suggestions with what was just generated

OUTPUT FORMAT: Return suggestions as JSON array:
[
  {
    "codocSyntax": "$functionName()",
    "reason": "Need to add function call because...",
    "insertLine": 42,
    "indentLevel": 2
  }
]

Return ONLY the JSON array, no additional text.`;
  }

  /**
   * Call OpenAI API with latest API version
   */
  private async callOpenAI(prompt: string, apiKey: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a code structure analysis assistant that suggests CODOC edits based on dependency impact.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: {
          type: 'text'
        },
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  }

  /**
   * Parse suggestions from OpenAI response
   */
  private parseSuggestions(response: string): SuggestedChange[] {
    try {
      // Extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const suggestions = JSON.parse(jsonMatch[0]);
      return suggestions.map((s: any) => ({
        codocSyntax: s.codocSyntax,
        reason: s.reason,
        insertLine: s.insertLine,
        indentLevel: s.indentLevel || 0
      }));
    } catch (error) {
      console.error('Failed to parse suggestions:', error);
      return [];
    }
  }

  /**
   * Cancel pending analysis
   */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

export const impactAnalysisService = new ImpactAnalysisService();
