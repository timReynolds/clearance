import path from "node:path";

import type { OwnersConfig } from "../owners/index.js";

type RuleConfig = OwnersConfig["rule"][number];
type RequirementConfig = RuleConfig["require"][number];
type NotifyConfig = OwnersConfig["notify"][number];

export type LoadedOwnershipFile = {
  config?: OwnersConfig;
  directory: string;
  path: string;
};

export type ResolveOwnershipInput = {
  changedFiles: string[];
  ownershipFiles: LoadedOwnershipFile[];
};

export type ResolutionDiagnostic = {
  filePath: string;
  message: string;
  severity: "error" | "warning";
};

export type RequirementOption = {
  count: number;
  from: string;
};

export type RequirementTrigger = {
  changedFile: string;
  matchedPath: string;
  ownersDirectory: string;
  ownersPath: string;
  pattern: string;
  ruleIndex: number;
};

export type AndRequirement = {
  count: number;
  from: string;
  identity: string;
  triggers: RequirementTrigger[];
  type: "and";
};

export type OrRequirement = {
  identity: string;
  options: RequirementOption[];
  triggers: RequirementTrigger[];
  type: "or";
};

export type NotificationTrigger = {
  changedFile: string;
  matchedPath: string;
  notifyIndex: number;
  ownersDirectory: string;
  ownersPath: string;
  pattern: string;
};

export type NotificationRecord = {
  identity: string;
  teams: string[];
  triggers: NotificationTrigger[];
  users: string[];
};

export type OwnershipResolution = {
  andRequirements: AndRequirement[];
  diagnostics: ResolutionDiagnostic[];
  notifications: NotificationRecord[];
  orRequirements: OrRequirement[];
};

export function resolveOwnership(input: ResolveOwnershipInput): OwnershipResolution {
  const ownershipByDirectory = indexOwnershipFiles(input.ownershipFiles);
  const andRequirements: AndRequirement[] = [];
  const orRequirements: OrRequirement[] = [];
  const notifications: NotificationRecord[] = [];
  const diagnostics: ResolutionDiagnostic[] = [];
  const andByIdentity = new Map<string, AndRequirement>();
  const orByIdentity = new Map<string, OrRequirement>();
  const notificationByIdentity = new Map<string, NotificationRecord>();

  for (const rawChangedFile of input.changedFiles) {
    const changedFile = normalizeRepositoryPath(rawChangedFile);
    if (changedFile === undefined || changedFile === ".") {
      diagnostics.push({
        filePath: rawChangedFile,
        message: "changed file path must be a relative repository file path",
        severity: "error",
      });
      continue;
    }

    for (const directory of getAncestorDirectories(changedFile)) {
      const ownershipFile = ownershipByDirectory.get(directory);
      const config = ownershipFile?.config;
      if (ownershipFile === undefined || config === undefined) {
        continue;
      }
      const resolvedOwnershipFile = {
        ...ownershipFile,
        config,
      };

      applyOwnershipFile({
        andByIdentity,
        andRequirements,
        changedFile,
        notificationByIdentity,
        notifications,
        orByIdentity,
        orRequirements,
        ownershipFile: resolvedOwnershipFile,
      });

      if (!config.inherit) {
        break;
      }
    }
  }

  return {
    andRequirements,
    diagnostics,
    notifications,
    orRequirements,
  };
}

function indexOwnershipFiles(
  ownershipFiles: LoadedOwnershipFile[],
): Map<string, LoadedOwnershipFile> {
  const ownershipByDirectory = new Map<string, LoadedOwnershipFile>();

  for (const ownershipFile of ownershipFiles.toSorted((left, right) =>
    compareRepositoryPaths(left.path, right.path),
  )) {
    const directory = normalizeOwnershipDirectory(ownershipFile.directory);
    if (directory === undefined || ownershipByDirectory.has(directory)) {
      continue;
    }

    ownershipByDirectory.set(directory, {
      ...ownershipFile,
      directory,
    });
  }

  return ownershipByDirectory;
}

function applyOwnershipFile(parameters: {
  andByIdentity: Map<string, AndRequirement>;
  andRequirements: AndRequirement[];
  changedFile: string;
  notificationByIdentity: Map<string, NotificationRecord>;
  notifications: NotificationRecord[];
  orByIdentity: Map<string, OrRequirement>;
  orRequirements: OrRequirement[];
  ownershipFile: LoadedOwnershipFile & { config: OwnersConfig };
}): void {
  const { changedFile, ownershipFile } = parameters;
  const matchedPath = getRelativePath(changedFile, ownershipFile.directory);
  if (matchedPath === undefined) {
    return;
  }

  for (const [ruleIndex, rule] of ownershipFile.config.rule.entries()) {
    const matchedPatterns = findMatchedPatterns(rule.paths, matchedPath);
    if (matchedPatterns.length === 0) {
      continue;
    }

    for (const requirement of rule.require) {
      addAndRequirement(parameters, requirement, ruleIndex, matchedPatterns, matchedPath);
    }

    if (rule.require_any.length > 0) {
      addOrRequirement(parameters, rule.require_any, ruleIndex, matchedPatterns, matchedPath);
    }
  }

  for (const [notifyIndex, notification] of ownershipFile.config.notify.entries()) {
    const matchedPatterns = findMatchedPatterns(notification.paths, matchedPath);
    if (matchedPatterns.length === 0) {
      continue;
    }

    addNotification(parameters, notification, notifyIndex, matchedPatterns, matchedPath);
  }
}

function addAndRequirement(
  parameters: {
    andByIdentity: Map<string, AndRequirement>;
    andRequirements: AndRequirement[];
    changedFile: string;
    ownershipFile: LoadedOwnershipFile;
  },
  requirement: RequirementConfig,
  ruleIndex: number,
  matchedPatterns: string[],
  matchedPath: string,
): void {
  const identity = createAndRequirementIdentity(parameters.ownershipFile.directory, requirement);
  let resolvedRequirement = parameters.andByIdentity.get(identity);

  if (resolvedRequirement === undefined) {
    resolvedRequirement = {
      count: requirement.count,
      from: requirement.from,
      identity,
      triggers: [],
      type: "and",
    };
    parameters.andByIdentity.set(identity, resolvedRequirement);
    parameters.andRequirements.push(resolvedRequirement);
  }

  resolvedRequirement.triggers.push(
    ...matchedPatterns.map((pattern) =>
      createRequirementTrigger(parameters.changedFile, parameters.ownershipFile, {
        matchedPath,
        pattern,
        ruleIndex,
      }),
    ),
  );
}

function addOrRequirement(
  parameters: {
    changedFile: string;
    orByIdentity: Map<string, OrRequirement>;
    orRequirements: OrRequirement[];
    ownershipFile: LoadedOwnershipFile;
  },
  requirements: RequirementConfig[],
  ruleIndex: number,
  matchedPatterns: string[],
  matchedPath: string,
): void {
  const identity = createOrRequirementIdentity(parameters.ownershipFile.directory, requirements);
  let resolvedRequirement = parameters.orByIdentity.get(identity);

  if (resolvedRequirement === undefined) {
    resolvedRequirement = {
      identity,
      options: requirements.map((requirement) => ({
        count: requirement.count,
        from: requirement.from,
      })),
      triggers: [],
      type: "or",
    };
    parameters.orByIdentity.set(identity, resolvedRequirement);
    parameters.orRequirements.push(resolvedRequirement);
  }

  resolvedRequirement.triggers.push(
    ...matchedPatterns.map((pattern) =>
      createRequirementTrigger(parameters.changedFile, parameters.ownershipFile, {
        matchedPath,
        pattern,
        ruleIndex,
      }),
    ),
  );
}

function addNotification(
  parameters: {
    changedFile: string;
    notificationByIdentity: Map<string, NotificationRecord>;
    notifications: NotificationRecord[];
    ownershipFile: LoadedOwnershipFile;
  },
  notification: NotifyConfig,
  notifyIndex: number,
  matchedPatterns: string[],
  matchedPath: string,
): void {
  if (notification.teams.length === 0 && notification.users.length === 0) {
    return;
  }

  const identity = createNotificationIdentity(parameters.ownershipFile.directory, notification);
  let notificationRecord = parameters.notificationByIdentity.get(identity);

  if (notificationRecord === undefined) {
    notificationRecord = {
      identity,
      teams: [...notification.teams],
      triggers: [],
      users: [...notification.users],
    };
    parameters.notificationByIdentity.set(identity, notificationRecord);
    parameters.notifications.push(notificationRecord);
  }

  notificationRecord.triggers.push(
    ...matchedPatterns.map((pattern): NotificationTrigger => {
      return {
        changedFile: parameters.changedFile,
        matchedPath,
        notifyIndex,
        ownersDirectory: parameters.ownershipFile.directory,
        ownersPath: parameters.ownershipFile.path,
        pattern,
      };
    }),
  );
}

function createRequirementTrigger(
  changedFile: string,
  ownershipFile: LoadedOwnershipFile,
  options: {
    matchedPath: string;
    pattern: string;
    ruleIndex: number;
  },
): RequirementTrigger {
  return {
    changedFile,
    matchedPath: options.matchedPath,
    ownersDirectory: ownershipFile.directory,
    ownersPath: ownershipFile.path,
    pattern: options.pattern,
    ruleIndex: options.ruleIndex,
  };
}

function findMatchedPatterns(patterns: string[], matchedPath: string): string[] {
  return patterns.filter((pattern) => matchesPathGlob(pattern, matchedPath));
}

function matchesPathGlob(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizeGlobPattern(pattern);
  if (normalizedPattern === undefined) {
    return false;
  }

  return matchesGlobSegments(splitPath(normalizedPattern), splitPath(filePath), 0, 0);
}

function matchesGlobSegments(
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
): boolean {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) {
      return true;
    }

    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchesGlobSegments(patternSegments, pathSegments, patternIndex + 1, nextPathIndex)) {
        return true;
      }
    }

    return false;
  }

  const pathSegment = pathSegments[pathIndex];
  if (pathSegment === undefined || !matchesPathSegment(patternSegment ?? "", pathSegment)) {
    return false;
  }

  return matchesGlobSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
}

function matchesPathSegment(patternSegment: string, pathSegment: string): boolean {
  const expression = new RegExp(
    `^${[...patternSegment].map((character) => globCharacterToRegex(character)).join("")}$`,
  );

  return expression.test(pathSegment);
}

function globCharacterToRegex(character: string): string {
  if (character === "*") {
    return "[^/]*";
  }

  if (character === "?") {
    return "[^/]";
  }

  return escapeRegExp(character);
}

function normalizeGlobPattern(pattern: string): string | undefined {
  const trimmedPattern = pattern.trim();
  if (trimmedPattern === "" || path.posix.isAbsolute(trimmedPattern)) {
    return undefined;
  }

  if (trimmedPattern.split("/").some((segment) => segment === "..")) {
    return undefined;
  }

  const normalizedPattern = path.posix.normalize(trimmedPattern);
  return normalizedPattern === "." ? "" : normalizedPattern;
}

function splitPath(filePath: string): string[] {
  if (filePath === "") {
    return [];
  }

  return filePath.split("/").filter((segment) => segment !== "");
}

function getAncestorDirectories(filePath: string): string[] {
  const directories: string[] = [];
  let directory = path.posix.dirname(filePath);

  while (true) {
    directories.push(directory);

    if (directory === ".") {
      return directories;
    }

    directory = path.posix.dirname(directory);
  }
}

function getRelativePath(filePath: string, directory: string): string | undefined {
  if (directory === ".") {
    return filePath;
  }

  if (!filePath.startsWith(`${directory}/`)) {
    return undefined;
  }

  return filePath.slice(directory.length + 1);
}

function createAndRequirementIdentity(directory: string, requirement: RequirementConfig): string {
  return `and:${directory}:${requirement.from}:${requirement.count}`;
}

function createOrRequirementIdentity(directory: string, requirements: RequirementConfig[]): string {
  return `or:${directory}:${createRequirementOptionsIdentity(requirements)}`;
}

function createRequirementOptionsIdentity(requirements: RequirementConfig[]): string {
  return requirements
    .map((requirement) => `${requirement.from}:${requirement.count}`)
    .toSorted(compareRepositoryPaths)
    .join("|");
}

function createNotificationIdentity(directory: string, notification: NotifyConfig): string {
  const teamIdentity = notification.teams.toSorted(compareRepositoryPaths).join(",");
  const userIdentity = notification.users.toSorted(compareRepositoryPaths).join(",");

  return `notify:${directory}:teams=${teamIdentity}:users=${userIdentity}`;
}

function normalizeOwnershipDirectory(directory: string): string | undefined {
  if (directory === ".") {
    return ".";
  }

  return normalizeRepositoryPath(directory);
}

function normalizeRepositoryPath(filePath: string): string | undefined {
  if (path.posix.isAbsolute(filePath)) {
    return undefined;
  }

  if (filePath.split("/").some((segment) => segment === "..")) {
    return undefined;
  }

  return path.posix.normalize(filePath);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
