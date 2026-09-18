import path from "node:path";

import { parseOwnersToml, type OwnersConfig, type OwnersDiagnostic } from "./schema.js";

export const ownersFileName = "OWNERS.toml";

export type RepositoryTreeEntry = {
  mode?: string;
  path?: string;
  sha?: string;
  type?: string;
};

export type PreparedOwnershipFile = {
  diagnostics: OwnersDiagnostic[];
  directory: string;
  path: string;
  sha?: string;
};

export type OwnershipFile = PreparedOwnershipFile & {
  config?: OwnersConfig;
};

export type OwnershipTree = {
  diagnostics: OwnersDiagnostic[];
  files: OwnershipFile[];
  truncated: boolean;
};

export type OwnershipDiscovery = {
  diagnostics: OwnersDiagnostic[];
  files: PreparedOwnershipFile[];
  truncated: boolean;
};

export type OwnershipFileContent = {
  error?: string;
  path: string;
  source?: string;
};

export function discoverOwnershipFiles(
  entries: RepositoryTreeEntry[],
  options: { truncated?: boolean } = {},
): OwnershipDiscovery {
  const diagnostics = options.truncated
    ? [
        buildDiagnostic(
          ".",
          "repository tree was truncated; OWNERS.toml discovery may be incomplete",
          "warning",
        ),
      ]
    : [];
  const candidates = entries
    .filter((entry) => isOwnershipTreeEntry(entry))
    .toSorted(compareTreeEntries);
  const seenDirectories = new Map<string, string>();
  const files = candidates.map((entry) => prepareOwnershipFile(entry, seenDirectories));

  return {
    diagnostics,
    files,
    truncated: options.truncated === true,
  };
}

export function buildOwnershipTree(
  discovery: OwnershipDiscovery,
  contents: OwnershipFileContent[],
): OwnershipTree {
  const contentByPath = new Map(contents.map((content) => [content.path, content]));
  const files = discovery.files
    .map((file) => parseOwnershipFile(file, contentByPath.get(file.path)))
    .toSorted((left, right) => compareRepositoryPaths(left.path, right.path));
  const diagnostics = [...discovery.diagnostics, ...files.flatMap((file) => file.diagnostics)];

  return {
    diagnostics,
    files,
    truncated: discovery.truncated,
  };
}

export function isLoadableOwnershipFile(file: PreparedOwnershipFile): boolean {
  return (
    file.sha !== undefined &&
    !file.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  );
}

function isOwnershipTreeEntry(entry: RepositoryTreeEntry): boolean {
  if (entry.path === undefined) {
    return false;
  }

  return getBaseName(entry.path) === ownersFileName;
}

function compareTreeEntries(left: RepositoryTreeEntry, right: RepositoryTreeEntry): number {
  const leftPath = left.path ?? "";
  const rightPath = right.path ?? "";
  const leftNormalized = normalizeRepositoryPath(leftPath) ?? leftPath;
  const rightNormalized = normalizeRepositoryPath(rightPath) ?? rightPath;
  const normalizedComparison = compareRepositoryPaths(leftNormalized, rightNormalized);

  if (normalizedComparison !== 0) {
    return normalizedComparison;
  }

  const leftIsCanonical = leftPath === leftNormalized;
  const rightIsCanonical = rightPath === rightNormalized;
  if (leftIsCanonical !== rightIsCanonical) {
    return leftIsCanonical ? -1 : 1;
  }

  return compareRepositoryPaths(leftPath, rightPath);
}

function prepareOwnershipFile(
  entry: RepositoryTreeEntry,
  seenDirectories: Map<string, string>,
): PreparedOwnershipFile {
  const filePath = entry.path ?? ownersFileName;
  const normalizedPath = normalizeRepositoryPath(filePath);
  const directory = getDirectory(normalizedPath ?? filePath);
  const diagnostics: OwnersDiagnostic[] = [];

  if (normalizedPath === undefined) {
    diagnostics.push(buildDiagnostic(filePath, "OWNERS.toml path contains traversal segments"));
  } else if (normalizedPath !== filePath) {
    diagnostics.push(
      buildDiagnostic(
        filePath,
        `OWNERS.toml path must be canonical; normalized path would be ${normalizedPath}`,
      ),
    );
  }

  if (entry.mode === "120000") {
    diagnostics.push(buildDiagnostic(filePath, "symlinked OWNERS.toml files are not supported"));
  } else if (entry.type !== "blob") {
    diagnostics.push(buildDiagnostic(filePath, "OWNERS.toml entry is not a blob"));
  }

  if (entry.sha === undefined) {
    diagnostics.push(buildDiagnostic(filePath, "OWNERS.toml entry is missing a blob sha"));
  }

  const existingPath = seenDirectories.get(directory);
  if (existingPath === undefined) {
    seenDirectories.set(directory, filePath);
  } else {
    diagnostics.push(
      buildDiagnostic(
        filePath,
        `duplicate ownership location for ${directory}; already discovered ${existingPath}`,
      ),
    );
  }

  return {
    diagnostics,
    directory,
    path: normalizedPath ?? filePath,
    sha: entry.sha,
  };
}

function parseOwnershipFile(
  file: PreparedOwnershipFile,
  content: OwnershipFileContent | undefined,
): OwnershipFile {
  if (file.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return file;
  }

  if (content?.error !== undefined) {
    return {
      ...file,
      diagnostics: [...file.diagnostics, buildDiagnostic(file.path, content.error)],
    };
  }

  if (content?.source === undefined) {
    return {
      ...file,
      diagnostics: [
        ...file.diagnostics,
        buildDiagnostic(file.path, "OWNERS.toml content was not loaded"),
      ],
    };
  }

  const parseResult = parseOwnersToml(content.source, { filePath: file.path });
  if (!parseResult.ok) {
    return {
      ...file,
      diagnostics: [...file.diagnostics, ...parseResult.diagnostics],
    };
  }

  return {
    ...file,
    config: parseResult.config,
    diagnostics: [...file.diagnostics, ...parseResult.diagnostics],
  };
}

function compareRepositoryPaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function normalizeRepositoryPath(filePath: string): string | undefined {
  if (path.posix.isAbsolute(filePath)) {
    return undefined;
  }

  const segments = filePath.split("/");
  if (segments.some((segment) => segment === "..")) {
    return undefined;
  }

  return path.posix.normalize(filePath);
}

function getDirectory(filePath: string): string {
  return path.posix.dirname(filePath);
}

function getBaseName(filePath: string): string {
  return path.posix.basename(filePath);
}

function buildDiagnostic(
  filePath: string,
  message: string,
  severity: OwnersDiagnostic["severity"] = "error",
): OwnersDiagnostic {
  return {
    filePath,
    message,
    schemaPath: "$",
    severity,
  };
}
