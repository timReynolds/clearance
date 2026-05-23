import type { AnchorStatus } from "./types.js";

export type AnchorRelocationInput = {
  currentLine?: number;
  currentPath?: string;
  originalLine: number;
  originalPath: string;
  sourceText: string;
};

export type AnchorRelocationFile = {
  patch?: string;
  path: string;
};

export type AnchorRelocationResult = {
  confidence: number;
  currentLine?: number;
  currentPath?: string;
  status: AnchorStatus;
};

export function relocateAnchor(
  anchor: AnchorRelocationInput,
  files: AnchorRelocationFile[],
): AnchorRelocationResult {
  const preferredPath = anchor.currentPath ?? anchor.originalPath;
  const preferredFile = files.find((file) => file.path === preferredPath);
  const source = normalizeAnchorSource(anchor.sourceText);

  if (source === "") {
    if (preferredFile !== undefined) {
      return {
        confidence: 0.6,
        currentLine: anchor.currentLine ?? anchor.originalLine,
        currentPath: preferredFile.path,
        status: "uncertain",
      };
    }

    return { confidence: 0, status: "deleted" };
  }

  if (preferredFile !== undefined) {
    const preferredMatch = findSourceMatch(preferredFile, source);
    if (preferredMatch !== undefined) {
      return {
        confidence: 1,
        currentLine: preferredMatch.line,
        currentPath: preferredFile.path,
        status: "current",
      };
    }
  }

  for (const file of files) {
    if (file.path === preferredPath) {
      continue;
    }

    const match = findSourceMatch(file, source);
    if (match !== undefined) {
      return {
        confidence: 0.85,
        currentLine: match.line,
        currentPath: file.path,
        status: "moved",
      };
    }
  }

  return {
    confidence: preferredFile === undefined ? 0 : 0.35,
    currentPath: preferredFile?.path,
    status: preferredFile === undefined ? "deleted" : "uncertain",
  };
}

function findSourceMatch(file: AnchorRelocationFile, source: string): { line: number } | undefined {
  const patch = file.patch;
  if (patch === undefined || patch.trim() === "") {
    return undefined;
  }

  const lines = parsePatchLines(patch);
  const normalizedLines = lines.map((line) => ({
    lineNumber: line.newLineNumber,
    text: normalizeAnchorSource(line.text),
  }));
  const sourceTokens = source.split(" ").filter((token) => token.length > 0);
  if (sourceTokens.length === 0) {
    return undefined;
  }

  let best: { line: number; score: number } | undefined;
  for (const line of normalizedLines) {
    if (line.lineNumber === undefined || line.text === "") {
      continue;
    }

    const lineTokens = new Set(line.text.split(" "));
    const hits = sourceTokens.filter((token) => lineTokens.has(token)).length;
    const score = hits / sourceTokens.length;
    if (score >= 0.75 && (best === undefined || score > best.score)) {
      best = { line: line.lineNumber, score };
    }
  }

  return best === undefined ? undefined : { line: best.line };
}

function parsePatchLines(patch: string): Array<{ newLineNumber?: number; text: string }> {
  const lines: Array<{ newLineNumber?: number; text: string }> = [];
  let newLineNumber: number | undefined;

  for (const rawLine of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk?.[1] !== undefined) {
      newLineNumber = Number.parseInt(hunk[1], 10);
      continue;
    }

    if (newLineNumber === undefined || rawLine.startsWith("\\ No newline")) {
      continue;
    }

    if (rawLine.startsWith("+") || rawLine.startsWith(" ")) {
      lines.push({ newLineNumber, text: rawLine.slice(1) });
      newLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      continue;
    }
  }

  return lines;
}

function normalizeAnchorSource(value: string): string {
  return value
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .join(" ");
}
