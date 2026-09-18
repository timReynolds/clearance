import { parse as parseToml } from "toml";
import { z, type ZodIssue } from "zod";

const defaultOwnersFilePath = "OWNERS.toml";

const durationSchema = z.string().regex(/^[1-9]\d*[smhdw]$/, {
  message: "expected a duration such as 30m, 4h, 2d, or 1w",
});

const actorSchema = z.string().regex(/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/, {
  message: "expected a GitHub user or team reference such as @alice or @org/team",
});

const teamSchema = z.string().regex(/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, {
  message: "expected a GitHub team reference such as @org/team",
});

const userSchema = z.string().regex(/^@[A-Za-z0-9_.-]+$/, {
  message: "expected a GitHub user reference such as @alice",
});

const requirementSchema = z
  .object({
    from: actorSchema,
    count: z.number().int().positive().default(1),
  })
  .strict();
type RequirementConfig = z.infer<typeof requirementSchema>;

const escalationSchema = z
  .object({
    warn_after: durationSchema.optional(),
    escalate_after: durationSchema.optional(),
    fallback_after: durationSchema.optional(),
    fallback_team: teamSchema.optional(),
    reset_on_push: z.boolean().optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    require: z.array(requirementSchema).default([]),
    require_any: createRequireAnySchema(),
    escalation: escalationSchema.optional(),
  })
  .strict();

const notifySchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    teams: z.array(teamSchema).default([]),
    users: z.array(userSchema).default([]),
  })
  .strict();

const overrideSchema = z
  .object({
    teams: z.array(teamSchema).min(1),
  })
  .strict();

type RequireAnyParseResult =
  | {
      data: RequirementConfig[][];
      success: true;
    }
  | {
      error: z.ZodError;
      success: false;
    };

export const ownersConfigSchema = z
  .object({
    dry_run: z.boolean().default(false),
    inherit: z.boolean().default(true),
    escalation: escalationSchema.optional(),
    rule: z.array(ruleSchema).default([]),
    notify: z.array(notifySchema).default([]),
    override: overrideSchema.optional(),
  })
  .strict();

export type OwnersConfig = z.infer<typeof ownersConfigSchema>;

export type OwnersDiagnosticSeverity = "error" | "warning";

export type OwnersDiagnostic = {
  column?: number;
  filePath: string;
  line?: number;
  lineText?: string;
  message: string;
  schemaPath: string;
  severity: OwnersDiagnosticSeverity;
};

export type OwnersParseOptions = {
  filePath?: string;
};

export type OwnersParseResult =
  | {
      config: OwnersConfig;
      diagnostics: OwnersDiagnostic[];
      ok: true;
    }
  | {
      diagnostics: OwnersDiagnostic[];
      errors: string[];
      ok: false;
    };

export function parseOwnersToml(
  source: string,
  options: OwnersParseOptions = {},
): OwnersParseResult {
  const filePath = options.filePath ?? defaultOwnersFilePath;

  try {
    const parsed = parseToml(source);
    const result = ownersConfigSchema.safeParse(parsed);

    if (!result.success) {
      const diagnostics = result.error.issues.flatMap((issue) =>
        buildDiagnosticsFromZodIssue(issue, source, filePath),
      );

      return {
        diagnostics,
        errors: diagnostics.map(formatDiagnostic),
        ok: false,
      };
    }

    return {
      config: result.data,
      diagnostics: [],
      ok: true,
    };
  } catch (error) {
    const diagnostic = buildDiagnosticFromTomlError(error, source, filePath);

    return {
      diagnostics: [diagnostic],
      errors: [formatDiagnostic(diagnostic)],
      ok: false,
    };
  }
}

function createRequireAnySchema(): z.ZodType<RequirementConfig[][]> {
  return z
    .unknown()
    .optional()
    .superRefine((value, context) => {
      const result = parseRequireAny(value);
      if (result.success) {
        return;
      }

      for (const issue of result.error.issues) {
        context.addIssue(issue as unknown as Parameters<typeof context.addIssue>[0]);
      }
    })
    .transform((value): RequirementConfig[][] => {
      const result = parseRequireAny(value);
      return result.success ? result.data : [];
    });
}

function parseRequireAny(value: unknown): RequireAnyParseResult {
  if (value === undefined) {
    return {
      data: [],
      success: true,
    };
  }

  if (Array.isArray(value) && value.length > 0 && value.every((entry) => Array.isArray(entry))) {
    const nestedResult = z.array(z.array(requirementSchema).min(1)).safeParse(value);
    return nestedResult.success
      ? {
          data: nestedResult.data,
          success: true,
        }
      : {
          error: nestedResult.error,
          success: false,
        };
  }

  const legacyResult = z.array(requirementSchema).safeParse(value);
  return legacyResult.success
    ? {
        data: legacyResult.data.length === 0 ? [] : [legacyResult.data],
        success: true,
      }
    : {
        error: legacyResult.error,
        success: false,
      };
}

function buildDiagnosticsFromZodIssue(
  issue: ZodIssue,
  source: string,
  filePath: string,
): OwnersDiagnostic[] {
  const unknownKeys = getUnknownKeys(issue);

  if (unknownKeys.length > 0) {
    return unknownKeys.map((key) => {
      const path = [...issue.path, key];
      const lineContext = findLineContextForSchemaPath(source, path);
      const diagnostic: OwnersDiagnostic = {
        filePath,
        message: `unrecognized key "${key}"`,
        schemaPath: formatSchemaPath(path),
        severity: "error",
      };

      Object.assign(diagnostic, lineContext);
      return diagnostic;
    });
  }

  const lineContext = findLineContextForSchemaPath(source, issue.path);
  const diagnostic: OwnersDiagnostic = {
    filePath,
    message: issue.message,
    schemaPath: formatSchemaPath(issue.path),
    severity: "error",
  };

  Object.assign(diagnostic, lineContext);
  return [diagnostic];
}

function buildDiagnosticFromTomlError(
  error: unknown,
  source: string,
  filePath: string,
): OwnersDiagnostic {
  const location = getTomlErrorLocation(error);
  const lineContext =
    location === undefined ? undefined : getLineContext(source, location.line, location.column);

  const diagnostic: OwnersDiagnostic = {
    filePath,
    message: error instanceof Error ? error.message : "failed to parse OWNERS.toml",
    schemaPath: "$",
    severity: "error",
  };

  Object.assign(diagnostic, lineContext);
  return diagnostic;
}

function formatDiagnostic(diagnostic: OwnersDiagnostic): string {
  const location =
    diagnostic.line === undefined
      ? diagnostic.filePath
      : `${diagnostic.filePath}:${diagnostic.line}${
          diagnostic.column === undefined ? "" : `:${diagnostic.column}`
        }`;

  return `${location} ${diagnostic.schemaPath}: ${diagnostic.message}`;
}

function formatSchemaPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((schemaPath, segment) => {
    if (typeof segment === "number") {
      return `${schemaPath}[${segment}]`;
    }

    return `${schemaPath}.${String(segment)}`;
  }, "$");
}

function getUnknownKeys(issue: ZodIssue): string[] {
  if (issue.code !== "unrecognized_keys" || !("keys" in issue) || !Array.isArray(issue.keys)) {
    return [];
  }

  return issue.keys.filter((key): key is string => typeof key === "string");
}

function getTomlErrorLocation(error: unknown): { column?: number; line: number } | undefined {
  if (typeof error !== "object" || error === null || !("location" in error)) {
    return undefined;
  }

  const location = error.location;
  if (typeof location !== "object" || location === null || !("start" in location)) {
    return undefined;
  }

  const start = location.start;
  if (typeof start !== "object" || start === null || !("line" in start)) {
    return undefined;
  }

  const line = start.line;
  if (typeof line !== "number") {
    return undefined;
  }

  const column = "column" in start && typeof start.column === "number" ? start.column : undefined;
  return { column, line };
}

function findLineContextForSchemaPath(
  source: string,
  path: readonly PropertyKey[],
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> | undefined {
  const lines = source.split(/\r?\n/);
  const [firstSegment, secondSegment] = path;

  if (typeof firstSegment !== "string") {
    return undefined;
  }

  if (firstSegment === "rule" && typeof secondSegment === "number") {
    return findLineContextInTable(lines, "rule", secondSegment, path);
  }

  if (firstSegment === "notify" && typeof secondSegment === "number") {
    return findLineContextInTable(lines, "notify", secondSegment, path);
  }

  if (firstSegment === "escalation" || firstSegment === "override") {
    return findLineContextInSection(lines, firstSegment, path);
  }

  return findKeyLineContext(lines, 0, lines.length - 1, firstSegment);
}

function findLineContextInSection(
  lines: string[],
  section: string,
  path: readonly PropertyKey[],
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> | undefined {
  const start = findSectionHeaderLine(lines, `[${section}]`, 0);
  if (start === undefined) {
    return undefined;
  }

  const end = findNextSectionLine(lines, start + 1);
  const key = lastStringSegment(path.slice(1));

  if (key === undefined) {
    return getLineContextFromLines(lines, start);
  }

  return findKeyLineContext(lines, start + 1, end, key) ?? getLineContextFromLines(lines, start);
}

function findLineContextInTable(
  lines: string[],
  table: "notify" | "rule",
  index: number,
  path: readonly PropertyKey[],
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> | undefined {
  const start = findSectionHeaderLine(lines, `[[${table}]]`, index);
  if (start === undefined) {
    return undefined;
  }

  const end = findNextSectionLine(lines, start + 1);
  const key = lastStringSegment(path.slice(2));

  if (key === undefined) {
    return getLineContextFromLines(lines, start);
  }

  return findKeyLineContext(lines, start + 1, end, key) ?? getLineContextFromLines(lines, start);
}

function findSectionHeaderLine(
  lines: string[],
  header: string,
  zeroBasedIndex: number,
): number | undefined {
  let found = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trim() !== header) {
      continue;
    }

    if (found === zeroBasedIndex) {
      return index;
    }

    found += 1;
  }

  return undefined;
}

function findNextSectionLine(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      return index - 1;
    }
  }

  return lines.length - 1;
}

function findKeyLineContext(
  lines: string[],
  start: number,
  end: number,
  key: string,
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> | undefined {
  const keyPattern = new RegExp(`(?:^|[\\s{,])${escapeRegExp(key)}\\s*=`);

  for (let index = start; index <= end; index += 1) {
    const line = lines[index] ?? "";

    if (keyPattern.test(line)) {
      return getLineContextFromLines(lines, index);
    }
  }

  return undefined;
}

function getLineContext(
  source: string,
  line: number,
  column?: number,
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> {
  return {
    column,
    line,
    lineText: source.split(/\r?\n/)[line - 1],
  };
}

function getLineContextFromLines(
  lines: string[],
  zeroBasedIndex: number,
): Pick<OwnersDiagnostic, "column" | "line" | "lineText"> {
  return {
    line: zeroBasedIndex + 1,
    lineText: lines[zeroBasedIndex],
  };
}

function lastStringSegment(path: readonly PropertyKey[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];

    if (typeof segment === "string") {
      return segment;
    }
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
