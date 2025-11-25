/**
 * ImpactAnalysisService - Edit-driven feedforward using OpenAI API
 * Analyzes dependency impact when user edits CODOC nodes
 */

import { SchemaNode, DependencyGraph, SuggestedChange, ImpactAnalysis } from '../types';
import { OpenAI } from 'openai';

export class ImpactAnalysisService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private feedforwardDebounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 1800; // 1.8 seconds
  private readonly FEEDFORWARD_DEBOUNCE_MS = 800; // 0.8 seconds for faster feedforward

  /**
   * Generate feedforward suggestions based on content edits
   * Debounced to avoid excessive API calls
   */
  generateFeedforwardSuggestions(
    content: string,
    cursorLine: number,
    cursorColumn: number,
    parsedSchema: any[],
    dependencyGraph: DependencyGraph,
    apiKey: string,
    rejectedPatterns?: Set<string>,
    onSuggestions?: (suggestions: any[]) => void
  ): void {
    // Clear existing timer
    if (this.feedforwardDebounceTimer) {
      clearTimeout(this.feedforwardDebounceTimer);
    }

    // Debounce feedforward generation
    this.feedforwardDebounceTimer = setTimeout(async () => {
      try {
        const suggestions = await this.performFeedforwardGeneration(
          content,
          cursorLine,
          cursorColumn,
          parsedSchema,
          dependencyGraph,
          apiKey,
          rejectedPatterns
        );

        if (onSuggestions && suggestions.length > 0) {
          onSuggestions(suggestions);
        }
      } catch (error) {
        console.error('Feedforward generation failed:', error);
      }
    }, this.FEEDFORWARD_DEBOUNCE_MS);
  }

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
   * Perform feedforward generation based on cursor position and context
   */
  private async performFeedforwardGeneration(
    content: string,
    cursorLine: number,
    cursorColumn: number,
    parsedSchema: any[],
    dependencyGraph: DependencyGraph,
    apiKey: string,
    rejectedPatterns?: Set<string>
  ): Promise<any[]> {
    // Build context around cursor
    const lines = content.split('\n');
    const beforeCursor = lines.slice(Math.max(0, cursorLine - 3), cursorLine);
    const currentLine = lines[cursorLine] || '';
    const afterCursor = lines.slice(cursorLine + 1, Math.min(lines.length, cursorLine + 4));

    // Calculate indent level
    const currentLineIndent = currentLine.length - currentLine.trimStart().length;

    // Determine current context (which node/file we're in)
    let currentContext = 'root';
    for (let i = cursorLine - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('/') || line.includes('.ts') || line.includes('.tsx')) {
        currentContext = line;
        break;
      }
    }

    // Build dependency context from graph
    const dependencyContext = this.buildDependencyContextForFeedforward(
      currentContext,
      dependencyGraph,
      parsedSchema
    );

    const context = {
      beforeCursor,
      currentLine,
      afterCursor,
      currentContext,
      currentLineIndent,
      dependencyContext
    };

    // Build prompt
    const { systemPrompt, userPrompt } = this.createFeedforwardPrompt(
      content,
      cursorLine,
      context,
      parsedSchema,
      dependencyContext,
      rejectedPatterns
    );

    // Call OpenAI
    const response = await this.callOpenAIForFeedforward(
      systemPrompt,
      userPrompt,
      apiKey
    );

    // Parse and structure suggestions
    const suggestions = this.parseFeedforwardResponse(
      response, 
      cursorLine, 
      currentLineIndent,
      content,
      parsedSchema
    );

    return suggestions;
  }

  /**
   * Build dependency context for feedforward
   */
  private buildDependencyContextForFeedforward(
    currentContext: string,
    dependencyGraph: DependencyGraph,
    parsedSchema: any[]
  ): string {
    // Find relevant nodes in dependency graph
    const relevantNodes: string[] = [];

    for (const [nodeId, node] of Object.entries(dependencyGraph.nodes)) {
      if (nodeId.includes(currentContext) || currentContext.includes(nodeId)) {
        relevantNodes.push(nodeId);
        // Add upstream and downstream dependencies
        relevantNodes.push(...node.upstream);
        relevantNodes.push(...node.downstream);
      }
    }

    if (relevantNodes.length === 0) {
      return 'No direct dependencies found.';
    }

    const uniqueNodes = [...new Set(relevantNodes)];
    return uniqueNodes.slice(0, 10).join(', ');
  }

  private createFeedforwardPrompt(
    content: string,
    cursorLine: number,
    context: any,
    parsedSchema: any[],
    dependencyContext: string,
    rejectedPatterns?: Set<string>
  ) {
    const systemPrompt = `You are an expert software architect providing intelligent feedforward suggestions for a CoDoc system using the Codoc syntax.

CODOC SYNTAX:
/directory - Folders
file.ext - Files  
%Component - React components
$function() - Functions
@reference - Links

OUTPUT FORMAT:
Use compact notation with > for nesting and ; for multiple items at same level:

EXAMPLES:
1. Authentication feature:
/auth>login.ts>$authenticateUser();$validateCredentials();$handleLogin()auth.types.ts>UserRole;AuthState
/components>LoginForm.tsx>%LoginForm;$handleSubmit();RegisterForm.tsx>%RegisterForm;$handleRegister()

----FIRST EXAMPLE----
/auth
  login.ts
    $authenticateUser()
    $validateCredentials()
    $handleLogin()
  auth.types.ts
    UserRole
    AuthState
/components
  LoginForm.tsx
    %LoginForm
    $handleSubmit()
  RegisterForm.tsx
    %RegisterForm
    $handleRegister()
----FIRST EXAMPLE----

2. API and utilities:
/api>users.ts>$fetchUser();$updateUser();$handleUserUpdate();posts.ts>$createPost();$deletePost();$handlePostDelete()
/utils>validation.ts>$validateEmail();$validatePassword();$handleValidation();helpers.ts>$formatDate();$sanitizeInput();$handleSanitization()

----SECOND EXAMPLE----
/api
  users.ts
    $fetchUser()
    $updateUser()
    $handleUserUpdate()
  posts.ts
    $createPost()
    $deletePost()
    $handlePostDelete()
/utils
  validation.ts
    $validateEmail()
    $validatePassword()
    $handleValidation()
  helpers.ts
    $formatDate()
    $sanitizeInput()
    $handleSanitization()
----SECOND EXAMPLE----

3. Component with hooks:
/components>UserProfile.tsx>%UserProfile;$useUserData();/hooks>useAuth.ts>$useAuth();$usePermissions()

----THIRD EXAMPLE----
/components
  UserProfile.tsx
    %UserProfile
    $useUserData()
    /hooks
      useAuth.ts
        $useAuth()
        $usePermissions()
----THIRD EXAMPLE----

4. Web Scraper:
/src>/test>scraper.ts>$scrapeWebsite();$parseHtml();scrapedResult.tsx>$handleResult();$displayResult();@ScrapedResult;/types>scraper.types.ts

----FOURTH EXAMPLE----
/src
  /test
    scraper.ts
      $scrapeWebsite()
      $parseHtml()
      $handleResult()
      $displayResult()
      @ScrapedResult
      /types
        scraper.types.ts

----FOURTH EXAMPLE----

5. Weather Dashboard:
/components>WeatherDashboard.tsx>%WeatherDashboard;$useWeatherData();/hooks>useWeather.ts>$useWeather();$useLocation()
/utils>weather.ts>$fetchWeather();$formatWeather();/types>weather.types.ts

----FIFTH EXAMPLE----
/components
  WeatherDashboard.tsx
    %WeatherDashboard
    $useWeatherData()
    /hooks
      useWeather.ts
        $useWeather()
        $useLocation()
/utils
  weather.ts
    $fetchWeather()
    $formatWeather()
  /types
    weather.types.ts
----FIFTH EXAMPLE----


CRITICAL RULES:
1. Suggest 2-4 PRACTICAL additions that complete the current structure
2. Focus on what's the most important and missing for a working application
3. Consider software engineering best practices
4. Use > for hierarchy (folder>file>function|component), ; for siblings at same level
5. Keep suggestions realistic and implementable
6. Group logically related items in same output line
7. if a new file or folder should be created, you should start with the existing folder name to indicate the position of the new file or folder

AVOID:
- Already existing elements (you can only mention about the existing elements for indicating the path)
- Overly generic suggestions
- Unrelated additions
- Suggesting directories, files, or functions that already exist in the current structure
- Duplicating any existing elements

${rejectedPatterns?.size ? `- Previously rejected patterns: ${Array.from(rejectedPatterns).join(', ')}` : ''}

Think like a senior engineer: What's the next logical piece to build this feature?`;

    const userPrompt = `
current whole codoc structure:
${content}
  
cursor position:
\`\`\`
${context.beforeCursor.join('\n')}
→ ${context.currentLine} [CURSOR HERE]
${context.afterCursor.join('\n')}
\`\`\`

Context: ${context.currentContext}
Current indent: ${context.currentLineIndent}
Related dependencies: ${dependencyContext}

What practical additions would complete this feature? Output in compact format.
IMPORTANT: Do NOT suggest any directories, files, or functions that already exist in the current structure above.
DO NOT INCLUDE ANYTHING ELSE IN YOUR RESPONSE, NO EXPLANATION, NO COMMENTS, NO THOUGHTS, NO MARKDOWN, NO NOTHING.
`;

    return { systemPrompt, userPrompt };
  }

  /**
   * Call OpenAI for feedforward suggestions
   */
  private async callOpenAIForFeedforward(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string
  ): Promise<string> {
    if (!apiKey) {
      throw new Error('OpenAI API key is missing.');
    }

    const openai = new OpenAI({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true,
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'text'
      },
      temperature: 0.25,
      max_tokens: 1200
    });

    let responseContent = completion.choices[0].message.content;
    if (!responseContent) {
      throw new Error('No response from OpenAI');
    }

    responseContent = responseContent.replace(/```json\n/, '').replace(/\n```/, '');
    responseContent = responseContent.replace(/```\n/, '').replace(/\n```/, '');

    // const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return responseContent;
  }

  /**
   * Parse feedforward response into structured suggestions
   * Properly handles compact notation: /path>file.ts>$function();$another()
   * Filters out existing elements to avoid duplicates
   */
  private parseFeedforwardResponse(
    response: string,
    baseLine: number,
    baseIndent: number,
    content: string,
    parsedSchema: any[]
  ): any[] {
    const suggestions: any[] = [];
    const lines = response.split('\n').filter(l => l.trim());

    // Extract existing structure from content for duplicate detection
    const existingElements = this.extractExistingElements(content);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

      // Parse compact notation: /path>file.ts>$function();$another()
      const parts = trimmed.split('>');
      const groupId = `group-${Date.now()}-${Math.random()}`;
      let sequence = 0;

      // Process hierarchical path: parts[0] might be a full path like "/src/components/Register.tsx"
      // which should be treated as context, not as new elements
      let contextPath = '';
      let startIndex = 0;

      // Check if first part is a full path to existing file/directory
      if (parts.length > 0) {
        const firstPart = parts[0].trim();
        // If it looks like a path (contains / and possibly a file extension)
        if (firstPart.startsWith('/') && (firstPart.includes('.') || parts.length > 1)) {
          // This is likely a context path pointing to existing structure
          contextPath = firstPart;
          startIndex = 1; // Skip first part, start from second part
          
          // Verify if this path exists
          const pathExists = existingElements.has(firstPart);
        }
      }

      // Track current indent based on nesting level
      for (let partIndex = startIndex; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        const items = part.split(';');
        const currentIndent = baseIndent + (partIndex - startIndex);

        for (const item of items) {
          const itemTrimmed = item.trim();
          if (!itemTrimmed) continue;

          // Check if this element already exists
          if (this.elementExists(itemTrimmed, existingElements, contextPath)) {
            continue;
          }

          const type = this.detectSuggestionType(itemTrimmed);
          
          // Build full path for context
          const pathParts = parts.slice(startIndex, partIndex + 1).map(p => p.split(';')[0].trim());
          const fullPath = contextPath + (contextPath ? '/' : '') + pathParts.join('/');

          suggestions.push({
            id: `ff-${Date.now()}-${sequence}-${Math.random()}`,
            text: itemTrimmed,
            insertLine: baseLine + 1,
            indentLevel: currentIndent,
            type,
            fullPath: fullPath + (itemTrimmed !== pathParts[pathParts.length - 1] ? `/${itemTrimmed}` : ''),
            groupId,
            sequence: sequence++,
            contextPath // Store context path for reference
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Extract existing elements from content for duplicate detection
   */
  private extractExistingElements(content: string): Set<string> {
    const elements = new Set<string>();
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Extract different element types
      if (trimmed.startsWith('/')) {
        // Directory: /components
        elements.add(trimmed);
      } else if (trimmed.includes('.')) {
        // File: Register.tsx
        elements.add(trimmed);
      } else if (trimmed.startsWith('$')) {
        // Function: $handleSubmit()
        elements.add(trimmed);
      } else if (trimmed.startsWith('%')) {
        // Component: %LoginForm
        elements.add(trimmed);
      } else if (trimmed.startsWith('@')) {
        // Reference: @UserType
        elements.add(trimmed);
      }
    }

    return elements;
  }

  /**
   * Check if an element already exists in the structure
   */
  private elementExists(
    element: string, 
    existingElements: Set<string>, 
    contextPath: string
  ): boolean {
    // Direct match
    if (existingElements.has(element)) {
      return true;
    }

    // Check with context path
    const fullPath = contextPath + (contextPath ? '/' : '') + element;
    if (existingElements.has(fullPath)) {
      return true;
    }

    // For files, check without leading slash
    if (element.includes('.')) {
      const withoutSlash = element.replace(/^\/+/, '');
      if (existingElements.has(withoutSlash)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect suggestion type from text
   */
  private detectSuggestionType(text: string): string {
    if (text.startsWith('/')) return 'directory';
    if (text.startsWith('%')) return 'component';
    if (text.startsWith('$')) return 'function';
    if (text.startsWith('@')) return 'reference';
    if (text.includes('.')) return 'file';
    return 'variable';
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
    if (this.feedforwardDebounceTimer) {
      clearTimeout(this.feedforwardDebounceTimer);
      this.feedforwardDebounceTimer = null;
    }
  }
}

export const impactAnalysisService = new ImpactAnalysisService();
