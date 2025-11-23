/**
 * Line parser for CODOC syntax
 * Parses individual lines into tokens
 */

import { CstParser } from "chevrotain";
import {
  allTokens,
  DirectoryStart,
  Identifier,
  FileExtension,
  Component,
  FunctionToken,
  Variable,
  Reference,
  UserNote,
  Content,
  Equals,
  StringLiteral,
  NumberLiteral
} from "./lexer";

export class CodocLineParser extends CstParser {
  constructor() {
    super(allTokens);
    this.performSelfAnalysis();
  }

  public line = this.RULE("line", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.directoryDecl) },
      { ALT: () => this.SUBRULE(this.fileDecl) },
      { ALT: () => this.SUBRULE(this.componentDecl) },
      { ALT: () => this.SUBRULE(this.functionDecl) },
      { ALT: () => this.SUBRULE(this.variableDecl) },
      { ALT: () => this.SUBRULE(this.referenceDecl) },
      { ALT: () => this.SUBRULE(this.noteDecl) },
      { ALT: () => this.CONSUME(Content) }
    ]);
  });

  private directoryDecl = this.RULE("directoryDecl", () => {
    this.CONSUME(DirectoryStart);
    this.CONSUME(Identifier);
  });

  private fileDecl = this.RULE("fileDecl", () => {
    this.CONSUME(Identifier);
    this.CONSUME(FileExtension);
  });

  private componentDecl = this.RULE("componentDecl", () => {
    this.CONSUME(Component);
  });

  private functionDecl = this.RULE("functionDecl", () => {
    this.CONSUME(FunctionToken);
  });

  private variableDecl = this.RULE("variableDecl", () => {
    this.CONSUME(Variable);
    this.OPTION(() => {
      this.CONSUME(Equals);
      this.SUBRULE(this.value);
    });
  });

  private referenceDecl = this.RULE("referenceDecl", () => {
    this.CONSUME(Reference);
  });

  private noteDecl = this.RULE("noteDecl", () => {
    this.CONSUME(UserNote);
    this.CONSUME(Content);
  });

  private value = this.RULE("value", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral) },
      { ALT: () => this.CONSUME(NumberLiteral) },
      { ALT: () => this.CONSUME(Identifier) }
    ]);
  });
}

export const lineParser = new CodocLineParser();
