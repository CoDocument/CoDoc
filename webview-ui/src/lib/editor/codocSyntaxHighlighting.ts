import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { CodocLexer } from "../../../../src/parser/lexer.js"; // Adjusted import path for standalone usage

/** Map Chevrotain token types to style classes */
function styleOfTokenType(typeName: string): string {
    switch (typeName) {
        case "DirectoryStart":
            return "cm-directoryStart";
        case "Reference":
            return "cm-reference";
        case "FunctionToken":
            return "cm-function";
        case "Component":
            return "cm-component";
        case "Variable":
            return "cm-variable";
        case "FileExtension":
            return "cm-fileExtension";
        case "Identifier":
            return "cm-identifier";
        case "Comment":
            return "cm-comment";
        case "StringLiteral":
            return "cm-string";
        case "NumberLiteral":
            return "cm-number";
        case "BooleanLiteral":
            return "cm-boolean";
        case "SuggestionPrefix":
            return "cm-suggestion-prefix";
        case "FeedbackPrefix":
            return "cm-feedback-prefix";
        case "UserNote":
            return "cm-user-note";
        case "ToolTrigger":
            return "cm-tool-trigger";
        case "Content":
            return "cm-content-token";
        default:
            return "cm-defaultToken";
    }
}

interface DecorationRange {
    from: number;
    to: number;
    decoration: Decoration;
}

/**
 * Enhanced ViewPlugin that highlights text based on Chevrotain tokens
 * and provides better integration with file structure
 */
const enhancedCustomHighlightPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.buildDecorations(view.state.doc.toString());
        }

        /** Called whenever the document changes or the viewport changes */
        update(update: ViewUpdate) {
            if (update.docChanged) {
                // Re-tokenize only if document changed
                this.decorations = this.buildDecorations(update.state.doc.toString());
            }
            // else keep the same decorations
        }

        /** 
         * Tokenize with Chevrotain and build a DecorationSet 
         * that applies classes to each token range with enhanced logic
         */
        buildDecorations(text: string): DecorationSet {
            const lines = text.split('\n');
            const allDecorations: DecorationRange[] = [];

            // Process line by line for better context awareness
            let globalOffset = 0;

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const line = lines[lineIndex];
                const trimmedLine = line.trim();

                if (trimmedLine) {
                    // Tokenize the current line
                    const lexResult = CodocLexer.tokenize(line);

                    // Collect token decorations
                    for (const token of lexResult.tokens) {
                        const className = styleOfTokenType(token.tokenType.name);
                        const deco = Decoration.mark({ class: className });

                        const from = globalOffset + token.startOffset;
                        const to = globalOffset + (token.endOffset ?? token.startOffset + token.image.length - 1) + 1;

                        if (from != null && to != null && from < to) {
                            allDecorations.push({ from, to, decoration: deco });
                        }
                    }

                    // Collect structural decorations
                    this.collectStructuralDecorations(allDecorations, line, globalOffset, lineIndex);
                }

                globalOffset += line.length + 1;
            }

            // Sort all decorations by 'from' position to satisfy RangeSetBuilder requirements
            allDecorations.sort((a, b) => a.from - b.from);

            // Build the RangeSetBuilder with sorted decorations
            const builder = new RangeSetBuilder<Decoration>();
            for (const { from, to, decoration } of allDecorations) {
                builder.add(from, to, decoration);
            }

            return builder.finish();
        }

        /**
         * Collect structural decorations based on indentation and context
         */
        collectStructuralDecorations(
            allDecorations: DecorationRange[],
            line: string,
            lineOffset: number,
            lineIndex: number
        ) {
            const indentMatch = line.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '';
            const indentLevel = Math.floor(indent.length / 2);
            const trimmed = line.trim();

            if (!trimmed) return;

            // Add indent guide for the current level only
            // if (indentLevel > 0) {
            //     const guideDeco = Decoration.mark({
            //         class: `cm-indent-guide-level-${Math.min(indentLevel, 5)}`,
            //         attributes: { 
            //             'data-indent-level': indentLevel.toString(),
            //             'style': `--indent-level: ${indentLevel};`
            //         }
            //     });

            //     allDecorations.push({
            //         from: lineOffset,
            //         to: lineOffset + line.length,
            //         decoration: guideDeco
            //     });
            // }

            // Add structural connection indicators for child elements
            const isStructural = this.isStructuralLine(trimmed);
            if (isStructural && indentLevel > 0) {
                const connectionDeco = Decoration.mark({
                    class: 'cm-structure-connection',
                    attributes: { 
                        'style': `--parent-indent: ${indentLevel - 1};`
                    }
                });

                allDecorations.push({
                    from: lineOffset,
                    to: lineOffset + line.length,
                    decoration: connectionDeco
                });
            }
        }

        /**
         * Check if a line represents a structural element
         */
        isStructuralLine(trimmed: string): boolean {
            return (
                // Directory - `/directory`
                (trimmed.startsWith('/') && !trimmed.includes('.')) ||
                // File - `file.ext`
                !!trimmed.match(/^[a-zA-Z][a-zA-Z0-9_]*\.(tsx?|jsx?|ts|js|json|css|scss|html|md)$/) ||
                // Function - `$function()`
                !!trimmed.match(/^\$[a-zA-Z][a-zA-Z0-9_]*\(\)$/) ||
                // Component - `%component`
                !!trimmed.match(/^%[a-zA-Z][a-zA-Z0-9_]*$/) ||
                // Human-only comments - `# note`
                trimmed.startsWith('#') ||
                // Reference - `@reference`
                !!trimmed.match(/^@[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/)
            );
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

export function codocSyntaxHighlighting() {
    return enhancedCustomHighlightPlugin;
}