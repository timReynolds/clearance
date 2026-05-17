export const clearanceStateBlockStart = "<!-- clearance-state:v1";
export const clearanceStateBlockEnd = "-->";

export type ClearanceStateRequirement = {
  approvedBy: string[];
  approvedHeadSha?: string;
  identity: string;
  label: string;
  relevantFiles?: string[];
  requiredCount: number;
  status: "approved" | "pending";
  type: "and" | "or";
};

export type AssignmentRecord = {
  assignedAt: string;
  requirementIdentity: string;
  reviewers: string[];
};

export type ApprovalRecord = {
  approvedAt: string;
  headSha: string;
  requirementIdentity: string;
  reviewer: string;
};

export type ClearanceStateWarning = {
  message: string;
  requirementIdentity?: string;
};

export type StateEvent = {
  actor?: string;
  at: string;
  message: string;
  requirementIdentity?: string;
  type: string;
};

export type ClearanceState = {
  approvals: ApprovalRecord[];
  assignments: AssignmentRecord[];
  escalations: StateEvent[];
  fallbackNotifications: StateEvent[];
  notificationsSent: string[];
  override?: {
    actor: string;
    at: string;
    label: string;
  };
  requirements: ClearanceStateRequirement[];
  version: 1;
  warnings: ClearanceStateWarning[];
};

export type ClearanceStateParseResult =
  | {
      ok: true;
      state: ClearanceState;
    }
  | {
      ok: false;
      reason: string;
      state: ClearanceState;
    };

export function createEmptyClearanceState(): ClearanceState {
  return {
    approvals: [],
    assignments: [],
    escalations: [],
    fallbackNotifications: [],
    notificationsSent: [],
    requirements: [],
    version: 1,
    warnings: [],
  };
}

export function serializeClearanceState(state: ClearanceState): string {
  return `${clearanceStateBlockStart}\n${JSON.stringify(state, null, 2)}\n${clearanceStateBlockEnd}`;
}

export function parseClearanceState(markdown: string | undefined): ClearanceStateParseResult {
  if (markdown === undefined) {
    return {
      ok: false,
      reason: "missing Clearance comment",
      state: createEmptyClearanceState(),
    };
  }

  const start = markdown.indexOf(clearanceStateBlockStart);
  if (start === -1) {
    return {
      ok: false,
      reason: "missing hidden Clearance state block",
      state: createEmptyClearanceState(),
    };
  }

  const jsonStart = start + clearanceStateBlockStart.length;
  const end = markdown.indexOf(clearanceStateBlockEnd, jsonStart);
  if (end === -1) {
    return {
      ok: false,
      reason: "unterminated hidden Clearance state block",
      state: createEmptyClearanceState(),
    };
  }

  const source = markdown.slice(jsonStart, end).trim();
  try {
    const parsed = JSON.parse(source);
    if (!isClearanceState(parsed)) {
      return {
        ok: false,
        reason: "hidden Clearance state block has an unsupported shape",
        state: createEmptyClearanceState(),
      };
    }

    return {
      ok: true,
      state: normalizeClearanceState(parsed),
    };
  } catch {
    return {
      ok: false,
      reason: "hidden Clearance state block contains malformed JSON",
      state: createEmptyClearanceState(),
    };
  }
}

export function renderClearanceComment(state: ClearanceState): string {
  const visibleSections = [
    "## Clearance",
    renderSummary(state),
    renderRequirementTable(state),
    renderWarnings(state),
    renderAuditLog(state),
  ].filter((section) => section !== "");

  return `${visibleSections.join("\n\n")}\n\n${serializeClearanceState(state)}\n`;
}

function renderSummary(state: ClearanceState): string {
  if (state.override !== undefined) {
    return `Review clearance is granted by override label \`${state.override.label}\`.`;
  }

  const pending = state.requirements.filter(
    (requirement) => requirement.status !== "approved",
  ).length;
  if (pending === 0 && state.requirements.length > 0) {
    return "All review requirements are satisfied.";
  }

  if (state.requirements.length === 0) {
    return "No review requirements were triggered.";
  }

  return `${pending} review requirement${pending === 1 ? "" : "s"} pending.`;
}

function renderRequirementTable(state: ClearanceState): string {
  if (state.requirements.length === 0) {
    return "";
  }

  const rows = state.requirements.map((requirement) => {
    return [
      requirement.status === "approved" ? "Granted" : "Pending",
      escapeTableCell(requirement.label),
      requirement.type.toUpperCase(),
      String(requirement.requiredCount),
      requirement.approvedBy.length === 0
        ? "-"
        : requirement.approvedBy.map((actor) => `\`${actor}\``).join(", "),
      requirement.approvedHeadSha === undefined ? "-" : `\`${requirement.approvedHeadSha}\``,
    ];
  });

  return renderMarkdownTable(
    ["Status", "Requirement", "Type", "Needed", "Approved By", "Head SHA"],
    rows,
  );
}

function renderWarnings(state: ClearanceState): string {
  if (state.warnings.length === 0) {
    return "";
  }

  return [
    "### Warnings",
    ...state.warnings.map((warning) => {
      const prefix =
        warning.requirementIdentity === undefined ? "" : `\`${warning.requirementIdentity}\`: `;
      return `- ${prefix}${warning.message}`;
    }),
  ].join("\n");
}

function renderAuditLog(state: ClearanceState): string {
  const events = [
    ...state.escalations,
    ...state.fallbackNotifications,
    ...(state.override === undefined
      ? []
      : [
          {
            actor: state.override.actor,
            at: state.override.at,
            message: `Override activated with label ${state.override.label}`,
            type: "override",
          },
        ]),
  ].toSorted((left, right) => compareStrings(left.at, right.at));

  if (events.length === 0) {
    return "";
  }

  return [
    "### Audit Log",
    ...events.map((event) => {
      const actor = event.actor === undefined ? "" : ` by \`${event.actor}\``;
      return `- ${event.at}: ${event.message}${actor}`;
    }),
  ].join("\n");
}

function renderMarkdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function isClearanceState(value: unknown): value is ClearanceState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.requirements) &&
    Array.isArray(record.assignments) &&
    Array.isArray(record.approvals) &&
    Array.isArray(record.warnings) &&
    Array.isArray(record.escalations) &&
    Array.isArray(record.fallbackNotifications) &&
    Array.isArray(record.notificationsSent)
  );
}

function normalizeClearanceState(state: ClearanceState): ClearanceState {
  return {
    approvals: state.approvals,
    assignments: state.assignments,
    escalations: state.escalations,
    fallbackNotifications: state.fallbackNotifications,
    notificationsSent: state.notificationsSent,
    override: state.override,
    requirements: state.requirements,
    version: 1,
    warnings: state.warnings,
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
