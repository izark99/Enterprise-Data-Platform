import { EngineError, type ErrorVars } from '../core/errors';

/**
 * Parser of `transform.formula` (spec §12.2 "Cú pháp"): Excel formula text → syntax tree. Pure
 * TypeScript, shared by the engine and the Designer; the text is written by an Admin, so the scanner
 * is a hand-written loop (no regular expression), the recursion is bounded (`MAX_DEPTH`) and every
 * failure is a `FormulaError` with a key and the character position.
 *
 * - Column references `[Tiêu đề]` / `[key]`; `]]` inside a reference is one `]` (Excel tables).
 * - Strings `"…"` (`""` is one quote), numbers with `.` as the decimal separator, `TRUE` / `FALSE`.
 * - Arguments are separated by `,` (MEMORY 2026-10-30 13:24); a `;` is a syntax error with the hint.
 * - Precedence as Excel, loosest first: comparisons, `&`, `+ -`, `* /`, `^` (left-associative),
 *   postfix `%`, prefix `-` / `+` (so `-2^2` = 4).
 */

/** Longest formula text (spec §12.2). */
export const MAX_LENGTH = 2000;
/** Deepest nesting of parentheses, function calls and prefix signs (spec §12.2). */
export const MAX_DEPTH = 64;

/**
 * A problem in a formula: an i18n key of `formula.error.*` with its variables, and the character
 * range `[start, end)` (0-based offsets in the formula text) for the Designer's underline. The
 * variable `pos` is the 1-based position shown in the text. Syntax errors carry a `context`
 * (`formula.error.syntax_<context>`).
 */
export class FormulaError extends EngineError {
  readonly start: number;
  readonly end: number;

  constructor(messageKey: string, params: ErrorVars, start: number, end: number = start + 1) {
    super(messageKey, { ...params, pos: start + 1 });
    this.name = 'FormulaError';
    this.start = start;
    this.end = Math.max(end, start + 1);
  }
}

export type CompareOp = '=' | '<>' | '<' | '>' | '<=' | '>=';
export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | CompareOp;

interface Span {
  readonly start: number;
  readonly end: number;
  /** Chained operations below and including this node (spec §12.2 `tooComplex`). */
  readonly height: number;
}

export type Ast =
  | (Span & { readonly kind: 'number'; readonly text: string })
  | (Span & { readonly kind: 'string'; readonly value: string })
  | (Span & { readonly kind: 'boolean'; readonly value: boolean })
  | (Span & { readonly kind: 'ref'; readonly name: string })
  | (Span & { readonly kind: 'unary'; readonly op: '-' | '+'; readonly arg: Ast })
  | (Span & { readonly kind: 'percent'; readonly arg: Ast })
  | (Span & {
      readonly kind: 'binary';
      readonly op: BinaryOp;
      readonly left: Ast;
      readonly right: Ast;
    })
  | (Span & {
      readonly kind: 'call';
      /** Upper case, without an `_xlfn.` / `_xlws.` prefix. */
      readonly name: string;
      readonly nameEnd: number;
      readonly args: readonly Ast[];
    });

type TokenKind = 'number' | 'string' | 'ref' | 'name' | 'op' | '(' | ')' | ',' | 'end';

interface Token {
  readonly kind: TokenKind;
  /** Number text, string value, reference name, name, or operator. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function syntax(context: string, start: number, end?: number): FormulaError {
  return new FormulaError('formula.error.syntax', { context }, start, end);
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_');
const isNameChar = (c: string | undefined): boolean => isLetter(c) || isDigit(c) || c === '.';
/** Whitespace between tokens: the characters JavaScript's `\s` matches. */
const isSpace = (c: string): boolean => c.trim() === '' || c === '﻿';

// Arrays, not sets: module-level code must stay side-effect free (tree-shaking, A-02-1).
const TWO_CHAR_OPS: readonly string[] = ['<>', '<=', '>='];
const ONE_CHAR_OPS: readonly string[] = ['=', '<', '>', '+', '-', '*', '/', '^', '&', '%'];

/** A quoted part (`"…"` or `[…]`) starting at `start`; the closing char doubled is one char. */
function quoted(
  text: string,
  start: number,
  close: string,
  context: string,
): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  for (;;) {
    if (i >= text.length) throw syntax(context, start, text.length);
    const c = text[i]!;
    if (c === close) {
      if (text[i + 1] === close) {
        value += close;
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += c;
    i++;
  }
}

/** Tokens of `text` from offset `from` (after the leading `=`). Offsets are in the whole text. */
function tokenize(text: string, from: number): Token[] {
  const out: Token[] = [];
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '"') {
      const q = quoted(text, start, '"', 'unterminatedString');
      out.push({ kind: 'string', value: q.value, start, end: q.end });
      i = q.end;
      continue;
    }
    if (c === '[') {
      const q = quoted(text, start, ']', 'unterminatedRef');
      if (q.value.trim() === '') throw syntax('emptyRef', start, q.end);
      out.push({ kind: 'ref', value: q.value, start, end: q.end });
      i = q.end;
      continue;
    }
    if (c === ';') throw syntax('semicolon', start);
    if (c === '(' || c === ')' || c === ',') {
      out.push({ kind: c, value: c, start, end: start + 1 });
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      while (isDigit(text[i])) i++;
      if (text[i] === '.') {
        i++;
        while (isDigit(text[i])) i++;
      }
      const e = text[i];
      if (e === 'e' || e === 'E') {
        let j = i + 1;
        if (text[j] === '+' || text[j] === '-') j++;
        if (isDigit(text[j])) {
          while (isDigit(text[j])) j++;
          i = j;
        }
      }
      out.push({ kind: 'number', value: text.slice(start, i), start, end: i });
      continue;
    }
    if (isLetter(c)) {
      while (isNameChar(text[i])) i++;
      out.push({ kind: 'name', value: text.slice(start, i), start, end: i });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      out.push({ kind: 'op', value: two, start, end: start + 2 });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      out.push({ kind: 'op', value: c, start, end: start + 1 });
      i++;
      continue;
    }
    throw syntax('unexpectedChar', start);
  }
  out.push({ kind: 'end', value: '', start: text.length, end: text.length });
  return out;
}

const COMPARE_OPS: readonly string[] = ['=', '<>', '<', '>', '<=', '>='];

/** `A1`, `AB12`: an Excel cell address typed instead of a `[column]` reference. */
function isCellAddress(name: string): boolean {
  let i = 0;
  let letters = 0;
  while (i < name.length && name[i]! >= 'A' && name[i]! <= 'Z') {
    i++;
    letters++;
  }
  if (letters === 0 || letters > 3 || i === name.length) return false;
  for (; i < name.length; i++) if (!isDigit(name[i])) return false;
  return true;
}

const node = <T extends Ast>(n: T): T => n;

class Parser {
  private i = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private take(): Token {
    const t = this.tokens[this.i]!;
    if (t.kind !== 'end') this.i++;
    return t;
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t.kind === 'op' && ops.includes(t.value);
  }

  private enter(at: Token): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaError('formula.error.tooDeep', { max: MAX_DEPTH }, at.start, at.end);
    }
  }

  private leave(): void {
    this.depth--;
  }

  parse(): Ast {
    const first = this.peek();
    if (first.kind === 'end') throw syntax('empty', first.start);
    const ast = this.comparison();
    const t = this.peek();
    if (t.kind !== 'end') {
      throw syntax(t.kind === ')' ? 'unbalanced' : 'unexpected', t.start, t.end);
    }
    return ast;
  }

  private binary(op: BinaryOp, left: Ast, right: Ast): Ast {
    return node({
      kind: 'binary',
      op,
      left,
      right,
      start: left.start,
      end: right.end,
      height: Math.max(left.height, right.height) + 1,
    });
  }

  private comparison(): Ast {
    let left = this.concat();
    while (this.peek().kind === 'op' && COMPARE_OPS.includes(this.peek().value)) {
      const op = this.take().value as CompareOp;
      left = this.binary(op, left, this.concat());
    }
    return left;
  }

  private concat(): Ast {
    let left = this.additive();
    while (this.isOp('&')) {
      this.take();
      left = this.binary('&', left, this.additive());
    }
    return left;
  }

  private additive(): Ast {
    let left = this.multiplicative();
    while (this.isOp('+', '-')) {
      const op = this.take().value as '+' | '-';
      left = this.binary(op, left, this.multiplicative());
    }
    return left;
  }

  private multiplicative(): Ast {
    let left = this.power();
    while (this.isOp('*', '/')) {
      const op = this.take().value as '*' | '/';
      left = this.binary(op, left, this.power());
    }
    return left;
  }

  /** `^` is left-associative in Excel: `2^3^2` = 64. */
  private power(): Ast {
    let left = this.percent();
    while (this.isOp('^')) {
      this.take();
      left = this.binary('^', left, this.percent());
    }
    return left;
  }

  private percent(): Ast {
    let arg = this.unary();
    while (this.isOp('%')) {
      const t = this.take();
      arg = node({ kind: 'percent', arg, start: arg.start, end: t.end, height: arg.height + 1 });
    }
    return arg;
  }

  /** Prefix signs bind tighter than `^` in Excel: `-2^2` = 4. */
  private unary(): Ast {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '-' || t.value === '+')) {
      this.take();
      this.enter(t);
      const arg = this.unary();
      this.leave();
      return node({
        kind: 'unary',
        op: t.value,
        arg,
        start: t.start,
        end: arg.end,
        height: arg.height + 1,
      });
    }
    return this.primary();
  }

  private primary(): Ast {
    const t = this.take();
    switch (t.kind) {
      case 'number':
        return node({ kind: 'number', text: t.value, start: t.start, end: t.end, height: 0 });
      case 'string':
        return node({ kind: 'string', value: t.value, start: t.start, end: t.end, height: 0 });
      case 'ref':
        return node({ kind: 'ref', name: t.value, start: t.start, end: t.end, height: 0 });
      case '(': {
        this.enter(t);
        const inner = this.comparison();
        const close = this.take();
        if (close.kind !== ')') throw syntax('missingParen', close.start, close.end);
        this.leave();
        return { ...inner, start: t.start, end: close.end };
      }
      case 'name': {
        let upper = t.value.toUpperCase();
        if (upper.startsWith('_XLFN.')) upper = upper.slice(6);
        else if (upper.startsWith('_XLWS.')) upper = upper.slice(6);
        if (this.peek().kind === '(') return this.call(upper, t);
        if (upper === 'TRUE' || upper === 'FALSE') {
          return node({
            kind: 'boolean',
            value: upper === 'TRUE',
            start: t.start,
            end: t.end,
            height: 0,
          });
        }
        if (isCellAddress(upper)) throw syntax('cellRef', t.start, t.end);
        throw syntax('name', t.start, t.end);
      }
      case 'end':
        throw syntax('end', t.start);
      case ')':
        throw syntax('unbalanced', t.start, t.end);
      default:
        throw syntax('unexpected', t.start, t.end);
    }
  }

  private call(name: string, nameToken: Token): Ast {
    const open = this.take();
    this.enter(open);
    const args: Ast[] = [];
    let height = 0;
    const done = (close: Token): Ast => {
      this.leave();
      return node({
        kind: 'call',
        name,
        nameEnd: nameToken.end,
        args,
        start: nameToken.start,
        end: close.end,
        height: height + 1,
      });
    };
    if (this.peek().kind === ')') return done(this.take());
    for (;;) {
      const arg = this.comparison();
      args.push(arg);
      if (arg.height > height) height = arg.height;
      const sep = this.take();
      if (sep.kind === ',') continue;
      if (sep.kind === ')') return done(sep);
      throw syntax(sep.kind === 'end' ? 'missingParen' : 'unexpected', sep.start, sep.end);
    }
  }
}

/**
 * Parses a formula. It must start with `=` (leading whitespace allowed) and be at most `MAX_LENGTH`
 * characters. Throws `FormulaError` (`formula.error.syntax`, `tooLong`, `tooDeep`).
 */
export function parseFormula(text: string): Ast {
  if (text.length > MAX_LENGTH) {
    throw new FormulaError('formula.error.tooLong', { max: MAX_LENGTH }, MAX_LENGTH, text.length);
  }
  let i = 0;
  while (i < text.length && isSpace(text[i]!)) i++;
  if (text[i] !== '=') throw syntax('missingEquals', 0);
  return new Parser(tokenize(text, i + 1)).parse();
}
