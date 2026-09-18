import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.js";
import {
  approvals,
  assignments,
  notificationsSent,
  outboxJobs,
  pullRequests,
  requirementFiles,
  requirements,
  stateEvents,
  webhookDeliveries,
} from "./schema.js";
import type { ClearanceState, StateEvent } from "../state/index.js";

export type PullRequestStateRef = {
  author: string;
  headSha: string;
  labels: string[];
  now: string;
  owner: string;
  pullNumber: number;
  repo: string;
};

export type TrackedRepository = Pick<PullRequestStateRef, "owner" | "repo">;

export type WebhookDeliveryInput = {
  action?: string;
  deliveryId: string;
  error?: string;
  event: string;
  payload?: unknown;
  status: "processing" | "processed" | "failed";
};

export type BeginWebhookDeliveryInput = Omit<WebhookDeliveryInput, "error" | "status">;

export type OutboxJobInput = {
  availableAt?: string;
  payload: Record<string, unknown>;
  type: string;
};

export type OutboxJobRecord = {
  attempts: number;
  id: string;
  payload: Record<string, unknown>;
  type: string;
};

export type OutboxJobFailureInput = {
  availableAt?: string;
  error: string;
  id: string;
  terminal: boolean;
};

export class DrizzleClearanceStore {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT, typeof schema>) {}

  async listTrackedRepositories(): Promise<TrackedRepository[]> {
    return this.db
      .selectDistinct({
        owner: pullRequests.owner,
        repo: pullRequests.repo,
      })
      .from(pullRequests)
      .orderBy(asc(pullRequests.owner), asc(pullRequests.repo));
  }

  async loadPullRequestState(
    ref: Pick<PullRequestStateRef, "owner" | "pullNumber" | "repo">,
  ): Promise<ClearanceState | undefined> {
    const rows = await this.db
      .select({ state: pullRequests.state })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.owner, ref.owner),
          eq(pullRequests.repo, ref.repo),
          eq(pullRequests.pullNumber, ref.pullNumber),
        ),
      )
      .limit(1);

    return rows[0]?.state;
  }

  async savePullRequestTransition(
    input: PullRequestStateRef,
    state: ClearanceState,
    jobs: OutboxJobInput[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(pullRequests)
        .values({
          author: input.author,
          headSha: input.headSha,
          labels: input.labels,
          lastProcessedAt: input.now,
          owner: input.owner,
          pullNumber: input.pullNumber,
          repo: input.repo,
          state,
        })
        .onConflictDoUpdate({
          set: {
            author: input.author,
            headSha: input.headSha,
            labels: input.labels,
            lastProcessedAt: input.now,
            state,
            updatedAt: sql`now()`,
          },
          target: [pullRequests.owner, pullRequests.repo, pullRequests.pullNumber],
        })
        .returning({ id: pullRequests.id });
      const pullRequestId = rows[0]?.id;
      if (pullRequestId === undefined) {
        throw new Error("failed to persist pull request state");
      }

      await tx.delete(requirementFiles).where(eq(requirementFiles.pullRequestId, pullRequestId));
      await tx.delete(requirements).where(eq(requirements.pullRequestId, pullRequestId));
      await tx.delete(assignments).where(eq(assignments.pullRequestId, pullRequestId));
      await tx.delete(approvals).where(eq(approvals.pullRequestId, pullRequestId));
      await tx.delete(notificationsSent).where(eq(notificationsSent.pullRequestId, pullRequestId));
      await tx.delete(stateEvents).where(eq(stateEvents.pullRequestId, pullRequestId));

      if (state.requirements.length > 0) {
        await tx.insert(requirements).values(
          state.requirements.map((requirement) => ({
            approvedBy: requirement.approvedBy,
            approvedHeadSha: requirement.approvedHeadSha,
            assignedReviewers: requirement.assignedReviewers ?? [],
            eligibleReviewers: requirement.eligibleReviewers ?? [],
            escalateAfter: requirement.escalateAfter,
            fallbackAfter: requirement.fallbackAfter,
            fallbackTeam: requirement.fallbackTeam,
            identity: requirement.identity,
            label: requirement.label,
            pendingSince: requirement.pendingSince,
            pullRequestId,
            relevantFiles: requirement.relevantFiles ?? [],
            requiredCount: requirement.requiredCount,
            resetOnPush: requirement.resetOnPush,
            status: requirement.status,
            type: requirement.type,
            updatedAt: requirement.updatedAt,
            warnAfter: requirement.warnAfter,
          })),
        );
      }

      const fileRows = state.requirements.flatMap((requirement) =>
        (requirement.relevantFiles ?? []).map((filePath) => ({
          filePath,
          pullRequestId,
          requirementIdentity: requirement.identity,
        })),
      );
      if (fileRows.length > 0) {
        await tx.insert(requirementFiles).values(fileRows);
      }

      if (state.assignments.length > 0) {
        await tx.insert(assignments).values(
          state.assignments.map((assignment) => ({
            assignedAt: assignment.assignedAt,
            pullRequestId,
            requirementIdentity: assignment.requirementIdentity,
            reviewers: assignment.reviewers,
          })),
        );
      }

      if (state.approvals.length > 0) {
        await tx.insert(approvals).values(
          state.approvals.map((approval) => ({
            approvedAt: approval.approvedAt,
            headSha: approval.headSha,
            pullRequestId,
            requirementIdentity: approval.requirementIdentity,
            reviewer: approval.reviewer,
          })),
        );
      }

      if (state.notificationsSent.length > 0) {
        await tx.insert(notificationsSent).values(
          state.notificationsSent.map((identity) => ({
            identity,
            pullRequestId,
          })),
        );
      }

      const events = buildStateEvents(state);
      if (events.length > 0) {
        await tx.insert(stateEvents).values(
          events.map((event, eventIndex) => ({
            actor: event.actor,
            at: event.at,
            eventIndex,
            message: event.message,
            pullRequestId,
            requirementIdentity: event.requirementIdentity,
            type: event.type,
          })),
        );
      }

      if (jobs.length > 0) {
        await tx.insert(outboxJobs).values(jobs);
      }
    });
  }

  async recordWebhookDelivery(input: WebhookDeliveryInput): Promise<void> {
    await this.db
      .insert(webhookDeliveries)
      .values({
        action: input.action,
        deliveryId: input.deliveryId,
        event: input.event,
        error: input.error,
        payload: input.payload,
        processedAt: input.status === "processing" ? undefined : new Date().toISOString(),
        status: input.status,
      })
      .onConflictDoUpdate({
        set: {
          action: input.action,
          error: input.error ?? null,
          event: input.event,
          payload: input.payload,
          processedAt: input.status === "processing" ? null : new Date().toISOString(),
          status: input.status,
        },
        target: webhookDeliveries.deliveryId,
      });
  }

  async beginWebhookDelivery(input: BeginWebhookDeliveryInput): Promise<boolean> {
    const inserted = await this.db
      .insert(webhookDeliveries)
      .values({
        action: input.action,
        deliveryId: input.deliveryId,
        event: input.event,
        payload: input.payload,
        status: "processing",
      })
      .onConflictDoNothing({
        target: webhookDeliveries.deliveryId,
      })
      .returning({ deliveryId: webhookDeliveries.deliveryId });
    if (inserted.length > 0) {
      return true;
    }

    const existing = await this.db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, input.deliveryId))
      .limit(1);
    if (existing[0]?.status !== "failed") {
      return false;
    }

    await this.db
      .update(webhookDeliveries)
      .set({
        action: input.action,
        error: null,
        event: input.event,
        payload: input.payload,
        processedAt: null,
        status: "processing",
      })
      .where(eq(webhookDeliveries.deliveryId, input.deliveryId));

    return true;
  }

  async claimOutboxJobs(limit: number): Promise<OutboxJobRecord[]> {
    if (limit <= 0) {
      return [];
    }

    return this.db.transaction(async (tx) => {
      const jobs = await tx
        .select({
          attempts: outboxJobs.attempts,
          id: outboxJobs.id,
          payload: outboxJobs.payload,
          type: outboxJobs.type,
        })
        .from(outboxJobs)
        .where(and(eq(outboxJobs.status, "pending"), lte(outboxJobs.availableAt, sql`now()`)))
        .orderBy(asc(outboxJobs.availableAt), asc(outboxJobs.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const jobIds = jobs.map((job) => job.id);
      if (jobIds.length === 0) {
        return [];
      }

      await tx
        .update(outboxJobs)
        .set({
          attempts: sql`${outboxJobs.attempts} + 1`,
          status: "processing",
          updatedAt: sql`now()`,
        })
        .where(inArray(outboxJobs.id, jobIds));

      return jobs.map((job) => ({
        attempts: job.attempts + 1,
        id: job.id,
        payload: job.payload,
        type: job.type,
      }));
    });
  }

  async completeOutboxJob(id: string): Promise<void> {
    await this.db
      .update(outboxJobs)
      .set({
        status: "completed",
        updatedAt: sql`now()`,
      })
      .where(eq(outboxJobs.id, id));
  }

  async failOutboxJob(input: OutboxJobFailureInput): Promise<void> {
    await this.db
      .update(outboxJobs)
      .set({
        availableAt: input.availableAt,
        lastError: input.error,
        status: input.terminal ? "failed" : "pending",
        updatedAt: sql`now()`,
      })
      .where(eq(outboxJobs.id, input.id));
  }
}

function buildStateEvents(state: ClearanceState): StateEvent[] {
  const overrideEvents =
    state.override === undefined
      ? []
      : [
          {
            actor: state.override.actor,
            at: state.override.at,
            message: "Override activated by @clearance override command",
            type: "override",
          },
        ];

  return [...state.escalations, ...state.fallbackNotifications, ...overrideEvents].toSorted(
    (left, right) => compareStrings(left.at, right.at),
  );
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
