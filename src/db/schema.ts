import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigint,
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
import type {
  AnchorStatus,
  PatchsetEventType,
  ReviewAttentionAction,
  ReviewFileStatus,
  ReviewThreadStatus,
} from "../review/index.js";

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

export const reviewUsers = clearanceSchema.table(
  "review_users",
  {
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    githubLogin: text("github_login").notNull(),
    githubUserId: bigint("github_user_id", { mode: "number" }),
    id: uuid("id").defaultRandom().primaryKey(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("review_users_github_login_unique").on(table.githubLogin),
    uniqueIndex("review_users_github_user_id_unique").on(table.githubUserId),
  ],
);

export const reviewSessions = clearanceSchema.table(
  "review_sessions",
  {
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    lastSeenAt: timestamp("last_seen_at", { mode: "string", withTimezone: true }),
    sessionTokenHash: text("session_token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => reviewUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("review_sessions_token_hash_unique").on(table.sessionTokenHash),
    index("review_sessions_user_idx").on(table.userId),
    index("review_sessions_expires_idx").on(table.expiresAt),
  ],
);

export const reviewUserTokens = clearanceSchema.table(
  "review_user_tokens",
  {
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { mode: "string", withTimezone: true }),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: uuid("user_id")
      .primaryKey()
      .references(() => reviewUsers.id, { onDelete: "cascade" }),
  },
  (table) => [index("review_user_tokens_expires_idx").on(table.expiresAt)],
);

export const reviewPatchsets = clearanceSchema.table(
  "review_patchsets",
  {
    actor: text("actor"),
    baseSha: text("base_sha"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    eventType: text("event_type").$type<PatchsetEventType>().notNull(),
    forcePush: boolean("force_push").default(false).notNull(),
    headSha: text("head_sha").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    parentSha: text("parent_sha"),
    patchsetNumber: integer("patchset_number").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    reconstructed: boolean("reconstructed").default(false).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.patchsetNumber] }),
    uniqueIndex("review_patchsets_pull_sha_unique").on(table.pullRequestId, table.headSha),
    index("review_patchsets_pull_created_idx").on(table.pullRequestId, table.createdAt),
  ],
);

export const reviewPatchsetFiles = clearanceSchema.table(
  "review_patchset_files",
  {
    additions: integer("additions").default(0).notNull(),
    deletions: integer("deletions").default(0).notNull(),
    filePath: text("file_path").notNull(),
    patch: text("patch"),
    patchsetNumber: integer("patchset_number").notNull(),
    previousFilePath: text("previous_file_path"),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    status: text("status").$type<ReviewFileStatus>().notNull(),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.patchsetNumber, table.filePath] }),
    index("review_patchset_files_path_idx").on(table.filePath),
  ],
);

export const reviewThreads = clearanceSchema.table(
  "review_threads",
  {
    anchorStatus: text("anchor_status").$type<AnchorStatus>().default("current").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
    githubFirstCommentId: bigint("github_first_comment_id", { mode: "number" }),
    githubThreadNodeId: text("github_thread_node_id"),
    id: uuid("id").defaultRandom().primaryKey(),
    marker: text("marker").notNull(),
    ownerLogin: text("owner_login").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    resolvedAt: timestamp("resolved_at", { mode: "string", withTimezone: true }),
    resolvedBy: text("resolved_by"),
    status: text("status").$type<ReviewThreadStatus>().default("open").notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("review_threads_marker_unique").on(table.marker),
    uniqueIndex("review_threads_github_thread_unique").on(table.githubThreadNodeId),
    index("review_threads_pull_status_idx").on(table.pullRequestId, table.status),
  ],
);

export const reviewThreadAnchors = clearanceSchema.table(
  "review_thread_anchors",
  {
    confidenceBasisPoints: integer("confidence_basis_points").default(10000).notNull(),
    currentLine: integer("current_line"),
    currentPatchsetNumber: integer("current_patchset_number"),
    currentPath: text("current_path"),
    originalLine: integer("original_line").notNull(),
    originalPatchsetNumber: integer("original_patchset_number").notNull(),
    originalPath: text("original_path").notNull(),
    side: text("side").notNull(),
    sourceText: text("source_text").notNull(),
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => reviewThreads.id, { onDelete: "cascade" }),
    tokenContext: jsonb("token_context")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [index("review_thread_anchors_current_path_idx").on(table.currentPath)],
);

export const reviewThreadComments = clearanceSchema.table(
  "review_thread_comments",
  {
    authorLogin: text("author_login").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    githubCommentId: bigint("github_comment_id", { mode: "number" }),
    githubNodeId: text("github_node_id"),
    githubUrl: text("github_url"),
    id: uuid("id").defaultRandom().primaryKey(),
    marker: text("marker").notNull(),
    mirroredToGithub: boolean("mirrored_to_github").default(false).notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => reviewThreads.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("review_thread_comments_marker_unique").on(table.marker),
    uniqueIndex("review_thread_comments_github_id_unique").on(table.githubCommentId),
    index("review_thread_comments_thread_idx").on(table.threadId),
  ],
);

export const reviewMarks = clearanceSchema.table(
  "review_marks",
  {
    filePath: text("file_path").notNull(),
    markedAt: timestamp("marked_at", { mode: "string", withTimezone: true }).notNull(),
    patchsetNumber: integer("patchset_number").notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userLogin: text("user_login").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.userLogin, table.filePath] }),
    index("review_marks_user_idx").on(table.userLogin),
  ],
);

export const reviewVisits = clearanceSchema.table(
  "review_visits",
  {
    lastVisitedAt: timestamp("last_visited_at", { mode: "string", withTimezone: true }).notNull(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userLogin: text("user_login").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.userLogin] }),
    index("review_visits_user_idx").on(table.userLogin),
  ],
);

export const reviewAttentionMembers = clearanceSchema.table(
  "review_attention_members",
  {
    addedAt: timestamp("added_at", { mode: "string", withTimezone: true }).notNull(),
    addedBy: text("added_by"),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    userLogin: text("user_login").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pullRequestId, table.userLogin] }),
    index("review_attention_members_pull_idx").on(table.pullRequestId),
  ],
);

export const reviewAttentionEvents = clearanceSchema.table(
  "review_attention_events",
  {
    action: text("action").$type<ReviewAttentionAction>().notNull(),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    targetLogin: text("target_login"),
  },
  (table) => [
    index("review_attention_events_pull_created_idx").on(table.pullRequestId, table.createdAt),
  ],
);

export const pullRequestRelations = relations(pullRequests, ({ many }) => ({
  approvals: many(approvals),
  assignments: many(assignments),
  attentionEvents: many(reviewAttentionEvents),
  attentionMembers: many(reviewAttentionMembers),
  events: many(stateEvents),
  marks: many(reviewMarks),
  notificationsSent: many(notificationsSent),
  patchsetFiles: many(reviewPatchsetFiles),
  patchsets: many(reviewPatchsets),
  requirementFiles: many(requirementFiles),
  requirements: many(requirements),
  threads: many(reviewThreads),
  visits: many(reviewVisits),
}));

export const reviewThreadRelations = relations(reviewThreads, ({ many, one }) => ({
  anchor: one(reviewThreadAnchors),
  comments: many(reviewThreadComments),
  pullRequest: one(pullRequests, {
    fields: [reviewThreads.pullRequestId],
    references: [pullRequests.id],
  }),
}));
