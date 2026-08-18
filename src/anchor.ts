import * as vscode from 'vscode';
import { AnchorV2, Baseline } from './threadLog';
import { translateAnchor } from './baseline';

const CONTEXT = 120;

export function captureAnchorV2(
  doc: vscode.TextDocument,
  range: vscode.Range,
  baseline: Baseline | null,
): AnchorV2 {
  const startOff = doc.offsetAt(range.start);
  const endOff = doc.offsetAt(range.end);
  const full = doc.getText();
  return {
    baseline,
    start: { line: range.start.line, char: range.start.character },
    end: { line: range.end.line, char: range.end.character },
    text: doc.getText(range),
    prefix: full.slice(Math.max(0, startOff - CONTEXT), startOff),
    suffix: full.slice(endOff, endOff + CONTEXT),
  };
}

export interface ResolvedAnchor {
  range: vscode.Range;
  /** 'exact': positions valid as persisted. 'diff': translated deterministically.
   *  'fuzzy': last-resort text match — must be badged in UI. */
  method: 'exact' | 'diff' | 'fuzzy';
}

/**
 * Resolution pipeline (spec "Resolution algorithm"): exact at baseline →
 * diff translation from baseline content → fuzzy text match → orphan (null).
 * `baseText` is the file content at the anchor's baseline, when recoverable.
 */
export function resolveAnchorV2(
  doc: vscode.TextDocument,
  anchor: AnchorV2,
  baseText: string | null,
): ResolvedAnchor | null {
  if (baseText !== null) {
    if (doc.getText() === baseText) {
      const range = rangeFrom(doc, anchor);
      if (range && doc.getText(range) === anchor.text) return { range, method: 'exact' };
    }
    const translated = translateAnchor(baseText, doc.getText(), anchor);
    if (translated) {
      const range = new vscode.Range(
        translated.start.line,
        translated.start.char,
        translated.end.line,
        Math.min(translated.end.char, doc.lineAt(Math.min(translated.end.line, doc.lineCount - 1)).text.length),
      );
      if (anchor.text === '' || doc.getText(range) === anchor.text) {
        return { range, method: 'diff' };
      }
    }
  } else {
    // No recoverable baseline: the persisted positions are the best guess.
    const range = rangeFrom(doc, anchor);
    if (range && doc.getText(range) === anchor.text) return { range, method: 'exact' };
  }
  const fuzzy = fuzzyResolve(doc, anchor);
  return fuzzy ? { range: fuzzy, method: 'fuzzy' } : null;
}

function rangeFrom(doc: vscode.TextDocument, anchor: AnchorV2): vscode.Range | null {
  if (anchor.start.line >= doc.lineCount || anchor.end.line >= doc.lineCount) return null;
  return new vscode.Range(
    anchor.start.line,
    anchor.start.char,
    anchor.end.line,
    Math.min(anchor.end.char, doc.lineAt(anchor.end.line).text.length),
  );
}

// ---------- last-resort fuzzy matching (v1's three tiers, minus tier 1) ----------

function fuzzyResolve(doc: vscode.TextDocument, anchor: AnchorV2): vscode.Range | null {
  const full = doc.getText();
  if (!anchor.text) {
    if (anchor.start.line < doc.lineCount) return doc.lineAt(anchor.start.line).range;
    return null;
  }

  // Exact text somewhere, scored by prefix/suffix context and proximity.
  const originalOffset = offsetGuess(doc, anchor);
  const occurrences: number[] = [];
  for (let i = full.indexOf(anchor.text); i !== -1; i = full.indexOf(anchor.text, i + 1)) {
    occurrences.push(i);
    if (occurrences.length > 200) break;
  }
  if (occurrences.length > 0) {
    let best = occurrences[0];
    let bestScore = -Infinity;
    for (const off of occurrences) {
      const prefix = full.slice(Math.max(0, off - anchor.prefix.length), off);
      const suffix = full.slice(off + anchor.text.length, off + anchor.text.length + anchor.suffix.length);
      const score =
        commonSuffixLen(prefix, anchor.prefix) +
        commonPrefixLen(suffix, anchor.suffix) -
        Math.abs(off - originalOffset) / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = off;
      }
    }
    return new vscode.Range(doc.positionAt(best), doc.positionAt(best + anchor.text.length));
  }

  return fuzzyLineMatch(doc, anchor);
}

function offsetGuess(doc: vscode.TextDocument, anchor: AnchorV2): number {
  const line = Math.min(anchor.start.line, doc.lineCount - 1);
  return doc.offsetAt(new vscode.Position(line, 0)) + anchor.start.char;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function fuzzyLineMatch(doc: vscode.TextDocument, anchor: AnchorV2): vscode.Range | null {
  const anchorLines = anchor.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (anchorLines.length === 0) return null;
  const docLines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) docLines.push(doc.lineAt(i).text.trim());

  const window = anchorLines.length;
  let bestStart = -1;
  let bestScore = 0;
  for (let start = 0; start + window <= docLines.length; start++) {
    let matches = 0;
    for (let j = 0; j < window; j++) {
      if (docLines[start + j] === anchorLines[j] && anchorLines[j].length > 0) matches++;
      else if (lineSimilar(docLines[start + j], anchorLines[j])) matches += 0.6;
    }
    const score = matches / window - Math.abs(start - anchor.start.line) / 10000;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (bestStart === -1 || bestScore < 0.5) return null;
  const endLine = Math.min(bestStart + window - 1, doc.lineCount - 1);
  return new vscode.Range(bestStart, 0, endLine, doc.lineAt(endLine).text.length);
}

function lineSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ta = new Set(a.split(/\W+/).filter(Boolean));
  const tb = b.split(/\W+/).filter(Boolean);
  if (tb.length === 0) return false;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit++;
  return hit / tb.length >= 0.6;
}
