/**
 * Dependency Highlight Extension
 * 
 * Highlights dependencies when cursor is on an element:
 * - Current element and its dependencies/dependents: opacity 1.0
 * - All other elements: opacity 0.6
 * 
 * Uses the dependency graph from AnalysisEngine to track relationships
 */

import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate
} from "@codemirror/view";
import {
    RangeSetBuilder,
    StateEffect,
    StateField,
    EditorState
} from "@codemirror/state";

export interface DependencyGraph {
    nodes: Record<string, DependencyNode>; // Plain object for JSON compatibility
    edges: DependencyEdge[];
}

export interface DependencyNode {
    id: string;
    name: string;
    type: 'directory' | 'file' | 'function' | 'component' | 'class';
    filePath: string;
    upstream: string[]; // Dependencies (what this needs)
    downstream: string[]; // Dependents (what needs this)
}

export interface DependencyEdge {
    from: string;
    to: string;
    type: 'import' | 'call' | 'reference' | 'contains';
}

// State effect to set the dependency graph
export const setDependencyGraph = StateEffect.define<DependencyGraph>();

// State field to store the dependency graph
const dependencyGraphField = StateField.define<DependencyGraph>({
    create() {
        return { nodes: {}, edges: [] };
    },
    update(graph, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setDependencyGraph)) {
                return effect.value;
            }
        }
        return graph;
    }
});

/**
 * Parse the current line to extract element information
 */
function parseLineForElement(doc: EditorState['doc'], lineNumber: number): {
    type: 'component' | 'function' | 'file' | 'directory' | null;
    name: string | null;
} {
    if (lineNumber < 1 || lineNumber > doc.lines) {
        return { type: null, name: null };
    }

    const line = doc.line(lineNumber);
    const text = line.text.trim();

    // Component: %ComponentName
    if (text.startsWith('%')) {
        return {
            type: 'component',
            name: text.substring(1)
        };
    }

    // Function: $functionName()
    if (text.startsWith('$') && text.includes('()')) {
        return {
            type: 'function',
            name: text.substring(1, text.indexOf('()'))
        };
    }

    // File: filename.ext
    if (text.match(/^\w+\.\w+$/)) {
        return {
            type: 'file',
            name: text
        };
    }

    // Directory: /dirname
    if (text.startsWith('/')) {
        return {
            type: 'directory',
            name: text.substring(1)
        };
    }

    return { type: null, name: null };
}

/**
 * Find the file path for the current cursor position
 * Returns the full path from the graph (e.g., 'src/components/Login.tsx')
 */
function findFilePathForCursor(
    doc: EditorState['doc'], 
    cursorLine: number, 
    graph: DependencyGraph
): string | null {
    // Walk up from cursor line to find the file
    for (let lineNum = cursorLine; lineNum >= 1; lineNum--) {
        const line = doc.line(lineNum);
        const text = line.text.trim();

        // Check if this is a file line (filename.ext)
        if (text.match(/^\w+\.\w+$/)) {
            // Search through graph nodes to find the full path
            for (const nodeId of Object.keys(graph.nodes)) {
                const node = graph.nodes[nodeId];
                // Check if this node is a file and ends with our filename
                if (node.type === 'file' && nodeId.endsWith(text)) {
                    return nodeId;
                }
            }
            // Fallback to just the filename if not found in graph
            return text;
        }
    }

    return null;
}

/**
 * Get all related node IDs (dependencies and dependents)
 */
function getRelatedNodeIds(
    elementName: string,
    elementType: string,
    filePath: string | null,
    graph: DependencyGraph
): Set<string> {
    const relatedIds = new Set<string>();

    // Build potential node ID
    const potentialNodeId = filePath ? `${filePath}:${elementName}` : elementName;

    // Add the current node
    relatedIds.add(potentialNodeId);

    // Find the node in the graph (now a plain object)
    const node = graph.nodes[potentialNodeId];
    if (!node) {
        // Try to find by name only
        for (const [nodeId, nodeData] of Object.entries(graph.nodes)) {
            if (nodeData.name === elementName && nodeData.type === elementType) {
                relatedIds.add(nodeId);
                // Add upstream and downstream
                nodeData.upstream.forEach(id => relatedIds.add(id));
                nodeData.downstream.forEach(id => relatedIds.add(id));
                break;
            }
        }
        return relatedIds;
    }

    // Add all upstream dependencies
    node.upstream.forEach(id => relatedIds.add(id));

    // Add all downstream dependents
    node.downstream.forEach(id => relatedIds.add(id));

    // Recursively add transitive dependencies (up to 2 levels)
    const addTransitiveDeps = (nodeId: string, depth: number) => {
        if (depth > 2) return;
        const n = graph.nodes[nodeId];
        if (!n) return;

        n.upstream.forEach(upId => {
            if (!relatedIds.has(upId)) {
                relatedIds.add(upId);
                addTransitiveDeps(upId, depth + 1);
            }
        });

        n.downstream.forEach(downId => {
            if (!relatedIds.has(downId)) {
                relatedIds.add(downId);
                addTransitiveDeps(downId, depth + 1);
            }
        });
    };

    addTransitiveDeps(potentialNodeId, 1);

    // Also add the file if we're looking at a function/component
    if (filePath && (elementType === 'function' || elementType === 'component')) {
        relatedIds.add(filePath);

        // Add all parent directories
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
            relatedIds.add(parts.slice(0, i).join('/'));
        }
    }

    return relatedIds;
}

/**
 * Build opacity decorations based on cursor position
 */
function buildDependencyDecorations(view: EditorView): DecorationSet {
    const doc = view.state.doc;
    const graph = view.state.field(dependencyGraphField);
    const cursorPos = view.state.selection.main.head;
    const cursorLine = doc.lineAt(cursorPos).number;

    // Parse the current line to get element info
    const currentElement = parseLineForElement(doc, cursorLine);

    // If no element is found, return empty decorations (no dimming)
    // This ensures all lines stay at normal opacity when unfocused
    if (!currentElement.type || !currentElement.name) {
        return Decoration.none;
    }

    // Check if graph is empty
    if (Object.keys(graph.nodes).length === 0) {
        return Decoration.none;
    }

    // Find the file path context (full path from graph)
    const filePath = findFilePathForCursor(doc, cursorLine, graph);

    // Get all related node IDs
    const relatedIds = getRelatedNodeIds(
        currentElement.name,
        currentElement.type,
        filePath,
        graph
    );


    // Build decorations
    const builder = new RangeSetBuilder<Decoration>();
    let dimmedCount = 0;
    let relatedCount = 0;

    for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
        const line = doc.line(lineNum);
        const element = parseLineForElement(doc, lineNum);

        if (!element.type || !element.name) {
            continue;
        }

        // Check if this element is related
        let isRelated = false;

        // Build potential node IDs for this element using full path from graph
        const lineFilePath = findFilePathForCursor(doc, lineNum, graph);

        // Try multiple node ID formats to match
        const possibleNodeIds = [
            lineFilePath ? `${lineFilePath}:${element.name}` : element.name,
            lineFilePath || '', // The file/directory itself
            element.name // Just the element name
        ];

        for (const nodeId of possibleNodeIds) {
            if (nodeId && relatedIds.has(nodeId)) {
                isRelated = true;
                relatedCount++;
                break;
            }
        }

        // Apply opacity decoration for non-related elements
        if (!isRelated && lineNum !== cursorLine) {
            builder.add(
                line.from,
                line.from,
                Decoration.line({
                    class: "cm-dimmedLine",
                    attributes: { "data-dependency-dimmed": "true" }
                })
            );
            dimmedCount++;
        }
    }

    return builder.finish();
}

/**
 * View plugin to manage dependency highlighting
 */
const dependencyHighlightPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = buildDependencyDecorations(view);
        }

        update(update: ViewUpdate) {
            // Rebuild decorations when cursor moves or graph changes
            if (update.selectionSet ||
                update.transactions.some(tr => tr.effects.some(e => e.is(setDependencyGraph)))) {
                this.decorations = buildDependencyDecorations(update.view);
            }
        }
    },
    {
        decorations: (plugin) => plugin.decorations
    }
);

/**
 * Theme for dependency highlighting
 */
const dependencyHighlightTheme = EditorView.baseTheme({
    ".cm-dimmedLine": {
        opacity: "0.6",
        transition: "opacity 0.2s ease"
    }
});

/**
 * Main extension combining all parts
 */
export function dependencyHighlightExtension() {
    return [
        dependencyGraphField,
        dependencyHighlightPlugin,
        dependencyHighlightTheme
    ];
}

/**
 * Helper to set the dependency graph
 */
export function setDependencyGraphInView(view: EditorView, graph: DependencyGraph) {
    view.dispatch({
        effects: setDependencyGraph.of(graph)
    });
}
