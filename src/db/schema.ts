import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { ClearanceState } from "../state/index.js";

export const clearanceSchema = pgSchema("clearance");

export const pullRequests = clearanceSchema.table(
  "pull_requests",
  {
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    headSha: text("head_sha").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    labels: jsonb("labels")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastProcessedAt: timestamp("last_processed_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    owner: text("owner").notNull(),
    pullNumber: integer("pull_number").notNull(),
    repo: text("repo").notNull(),
    state: jsonb("state").$type<ClearanceState>().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("pull_requests_owner_repo_number_unique").on(
      table.owner,
      table.repo,
      table.pullNumber,
    ),
    index("pull_requests_owner_repo_idx").on(table.owner, table.repo),
    index("pull_requests_head_sha_idx").on(table.headSha),
  ],
);

export const requirements = clearanceSchema.table(
  "requirements",
  {
    approvedBy: jsonb("approved_by")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvedHeadSha: text("approved_head_sha"),
    assignedReviewers: jsonb("assigned_reviewers")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    eligibleReviewers: jsonb("eligible_reviewers")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    escalateAfter: text("escalate_after"),
    fallbackAfter: text("fallback_after"),
    fallbackTeam: text("fallback_team"),
    identity: text("identity").notNull(),
    label: text("label").notNull(),
    pendingSince: timestamp("pending_since", { mode: "string", withTimezone: true }),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    relevantFiles: jsonb("relevant_files")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    requiredCount: integer("required_count").notNull(),
    resetOnPush: boolean("reset_on_push"),
    status: text("status").notNull(),
    type: text("type").notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }),
    warnAfter: text("warn_after"),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.identity] }),
    index("requirements_status_idx").on(table.status),
    index("requirements_pending_since_idx").on(table.pendingSince),
  ],
);

export const requirementFiles = clearanceSchema.table(
  "requirement_files",
  {
    filePath: text("file_path").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    requirementIdentity: text("requirement_identity").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.pullRequestId, table.requirementIdentity, table.filePath],
    }),
    index("requirement_files_path_idx").on(table.filePath),
  ],
);

export const assignments = clearanceSchema.table(
  "assignments",
  {
    assignedAt: timestamp("assigned_at", { mode: "string", withTimezone: true }).notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    requirementIdentity: text("requirement_identity").notNull(),
    reviewers: jsonb("reviewers")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.requirementIdentity] }),
    index("assignments_reviewers_idx").using("gin", table.reviewers),
  ],
);

export const approvals = clearanceSchema.table(
  "approvals",
  {
    approvedAt: timestamp("approved_at", { mode: "string", withTimezone: true }).notNull(),
    headSha: text("head_sha").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    requirementIdentity: text("requirement_identity").notNull(),
    reviewer: text("reviewer").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.requirementIdentity, table.reviewer] }),
    index("approvals_reviewer_idx").on(table.reviewer),
    index("approvals_head_sha_idx").on(table.headSha),
  ],
);

export const notificationsSent = clearanceSchema.table(
  "notifications_sent",
  {
    identity: text("identity").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.pullRequestId, table.identity] })],
);

export const stateEvents = clearanceSchema.table(
  "state_events",
  {
    actor: text("actor"),
    at: timestamp("at", { mode: "string", withTimezone: true }).notNull(),
    eventIndex: integer("event_index").notNull(),
    message: text("message").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    requirementIdentity: text("requirement_identity"),
    type: text("type").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.eventIndex] }),
    index("state_events_type_idx").on(table.type),
    index("state_events_at_idx").on(table.at),
  ],
);

export const webhookDeliveries = clearanceSchema.table(
  "webhook_deliveries",
  {
    action: text("action"),
    deliveryId: text("delivery_id").primaryKey(),
    error: text("error"),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    processedAt: timestamp("processed_at", { mode: "string", withTimezone: true }),
    receivedAt: timestamp("received_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    index("webhook_deliveries_event_idx").on(table.event),
    index("webhook_deliveries_status_idx").on(table.status),
  ],
);

export const outboxJobs = clearanceSchema.table(
  "outbox_jobs",
  {
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    lastError: text("last_error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("pending").notNull(),
    type: text("type").notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("outbox_jobs_available_idx").on(table.status, table.availableAt),
    index("outbox_jobs_type_idx").on(table.type),
  ],
);

export const pullRequestRelations = relations(pullRequests, ({ many }) => ({
  approvals: many(approvals),
  assignments: many(assignments),
  events: many(stateEvents),
  notificationsSent: many(notificationsSent),
  requirementFiles: many(requirementFiles),
  requirements: many(requirements),
}));
