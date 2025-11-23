/**
 * Lexer for CODOC syntax using Chevrotain
 * Enhanced with comment support and dependency tracking
 */

import { createToken, Lexer } from "chevrotain";

export const NewLine = createToken({
  name: "NewLine",
  pattern: /\n/
});

export const DirectoryStart = createToken({
  name: "DirectoryStart",
  pattern: /\//
});

export const FileExtension = createToken({
  name: "FileExtension",
  pattern: /\.(tsx|jsx|ts|js|json|css|scss|html|md|py|java|cpp|c|go|rs|rb|php|yaml|yml|xml|sql|sh|bash)/
});

// Component syntax - React/UI components
export const Component = createToken({
  name: "Component",
  pattern: /%[a-zA-Z][a-zA-Z0-9_]*/
});

// Function syntax
export const FunctionToken = createToken({
  name: "FunctionToken",
  pattern: /\$[a-zA-Z][a-zA-Z0-9_]*\(\)/
});

// Reference syntax - for dependencies
export const Reference = createToken({
  name: "Reference",
  pattern: /@[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*/
});

// Variable syntax
export const Variable = createToken({
  name: "Variable",
  pattern: /var[a-zA-Z][a-zA-Z0-9_]*/
});

// User notes (comments)
export const UserNote = createToken({
  name: "UserNote",
  pattern: /#/
});

// String literals
export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"[^"]*"/
});

export const NumberLiteral = createToken({
  name: "NumberLiteral",
  pattern: /\d+(\.\d+)?/
});

// Assignment operator
export const Equals = createToken({
  name: "Equals",
  pattern: /=/
});

export const Identifier = createToken({
  name: "Identifier",
  pattern: /[a-zA-Z][a-zA-Z0-9_\-]*/
});

// Content for notes - everything until end of line
export const Content = createToken({
  name: "Content",
  pattern: /[^\n\r]+/
});

export const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /[ \t]+/,
  group: Lexer.SKIPPED
});

// Token order matters: longer/more specific patterns first
export const allTokens = [
  WhiteSpace,
  UserNote,
  StringLiteral,
  NumberLiteral,
  Component,
  Variable,
  Reference,
  FunctionToken,
  FileExtension,
  DirectoryStart,
  Equals,
  Identifier,
  Content,
  NewLine
];

export const CodocLexer = new Lexer(allTokens);