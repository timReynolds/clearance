import { and, asc, eq, sql } from "drizzle-orm";

import type { ClearanceDatabase } from "../db/index.js";
import {
  pullRequests,
  reviewAttentionEvents,
  reviewAttentionMembers,
  reviewMarks,
  reviewPatchsetFiles,
  reviewPatchsets,
  reviewThreadAnchors,
  reviewThreadComments,
  reviewThreads,
  reviewVisits,
} from "../db/schema.js";
import type {
  AttentionPassRequest,
  CreateThreadRequest,
  MarkReviewedRequest,
  ReplyThreadRequest,
  ReviewAttentionMember,
  ReviewFile,
  ReviewMarkState,
  ReviewPatchset,
  ReviewSnapshot,
  ReviewStateSummary,
  ReviewThread,
} from "./types.js";
import { relocateAnchor } from "./anchors.js";

export type ReviewPullRequestRef = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type ReviewPatchsetFileInput = {
  additions: number;
  deletions: number;
  patch?: string;
  path: string;
  previousPath?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "unchanged";
};

export type ReviewPatchsetInput = {
  actor?: string;
  baseSha?: string;
  createdAt: string;
  eventType: ReviewPatchset["eventType"];
  files: ReviewPatchsetFileInput[];
  forcePush: boolean;
  headSha: string;
  parentSha?: string;
};

export type GithubReviewCommentIngestInput = {
  authorLogin: string;
  body: string;
  createdAt: string;
  githubCommentId: number;
  githubNodeId?: string;
  githubRootCommentId?: number;
  githubThreadNodeId?: string;
  githubUrl?: string;
  line?: number;
  marker: string;
  path: string;
  side?: "LEFT" | "RIGHT";
  sourceText?: string;
  threadId: string;
};

export type ReviewSnapshotOptions = {
  fromPatchsetNumber?: number;
  toPatchsetNumber?: number;
};

export class DrizzleReviewStore {
  constructor(private readonly db: ClearanceDatabase) {}

  async loadSnapshot(
    ref: ReviewPullRequestRef,
    viewerLogin: string | undefined,
    options: ReviewSnapshotOptions = {},
  ): Promise<ReviewSnapshot | undefined> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return undefined;
    }

    const [
      storedPatchsets,
      storedFiles,
      storedMarks,
      storedThreads,
      storedAnchors,
      comments,
      visits,
      attention,
    ] = await Promise.all([
      this.db
        .select()
        .from(reviewPatchsets)
        .where(eq(reviewPatchsets.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewPatchsets.patchsetNumber)),
      this.db
        .select()
        .from(reviewPatchsetFiles)
        .where(eq(reviewPatchsetFiles.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewPatchsetFiles.filePath)),
      viewerLogin === undefined
        ? Promise.resolve([])
        : this.db
            .select()
            .from(reviewMarks)
            .where(
              and(
                eq(reviewMarks.pullRequestId, pullRequest.id),
                eq(reviewMarks.userLogin, viewerLogin),
              ),
            ),
      this.db
        .select()
        .from(reviewThreads)
        .where(eq(reviewThreads.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewThreads.createdAt)),
      this.db
        .select()
        .from(reviewThreadAnchors)
        .innerJoin(reviewThreads, eq(reviewThreadAnchors.threadId, reviewThreads.id))
        .where(eq(reviewThreads.pullRequestId, pullRequest.id)),
      this.db
        .select()
        .from(reviewThreadComments)
        .innerJoin(reviewThreads, eq(reviewThreadComments.threadId, reviewThreads.id))
        .where(eq(reviewThreads.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewThreadComments.createdAt)),
      viewerLogin === undefined
        ? Promise.resolve([])
        : this.db
            .select()
            .from(reviewVisits)
            .where(
              and(
                eq(reviewVisits.pullRequestId, pullRequest.id),
                eq(reviewVisits.userLogin, viewerLogin),
              ),
            )
            .limit(1),
      this.db
        .select()
        .from(reviewAttentionMembers)
        .where(eq(reviewAttentionMembers.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewAttentionMembers.addedAt)),
    ]);

    const patchsets =
      storedPatchsets.length === 0
        ? [buildReconstructedPatchset(pullRequest)]
        : storedPatchsets.map((patchset): ReviewPatchset => {
            return {
              actor: patchset.actor ?? undefined,
              baseSha: patchset.baseSha ?? undefined,
              createdAt: patchset.createdAt,
              eventType: patchset.eventType,
              forcePush: patchset.forcePush,
              headSha: patchset.headSha,
              parentSha: patchset.parentSha ?? undefined,
              patchsetNumber: patchset.patchsetNumber,
              reconstructed: patchset.reconstructed,
            };
          });
    const latestPatchset = patchsets.at(-1) ?? buildReconstructedPatchset(pullRequest);
    const selectedToPatchset =
      patchsets.find((patchset) => patchset.patchsetNumber === options.toPatchsetNumber) ??
      latestPatchset;
    const defaultFromPatchset = getDefaultFromPatchset(patchsets, storedMarks);
    const selectedFromPatchsetNumber =
      options.fromPatchsetNumber === undefined
        ? defaultFromPatchset
        : clampPatchsetNumber(options.fromPatchsetNumber, patchsets);
    const markByPath = new Map(storedMarks.map((mark) => [mark.filePath, mark]));
    const changedAfterMarkByPath = buildChangedAfterMarkByPath(storedFiles, storedMarks);
    const changedPathsInComparison = getChangedPathsInComparison(
      storedFiles,
      selectedFromPatchsetNumber,
      selectedToPatchset.patchsetNumber,
    );
    const selectedPatchsetFiles = storedFiles.filter(
      (file) => file.patchsetNumber === selectedToPatchset.patchsetNumber,
    );
    const files = buildReviewFiles({
      changedAfterMarkByPath,
      files:
        selectedPatchsetFiles.length === 0 || changedPathsInComparison.size === 0
          ? selectedPatchsetFiles
          : selectedPatchsetFiles.filter(
              (file) =>
                changedPathsInComparison.has(file.filePath) ||
                (file.previousFilePath !== null &&
                  changedPathsInComparison.has(file.previousFilePath)),
            ),
      latestPatchsetNumber: selectedToPatchset.patchsetNumber,
      marksByPath: markByPath,
      stateRelevantFiles: getRelevantFilesFromState(pullRequest.state),
    });
    const threadsById = new Map(
      storedThreads.map((thread): [string, ReviewThread] => {
        return [
          thread.id,
          {
            anchor: {
              confidence: 1,
              originalLine: 1,
              originalPatchsetNumber: selectedToPatchset.patchsetNumber,
              originalPath: files[0]?.path ?? "",
              side: "RIGHT",
              sourceText: "",
              status: thread.anchorStatus,
            },
            comments: [],
            id: thread.id,
            owner: { login: thread.ownerLogin },
            status: thread.status,
          },
        ];
      }),
    );

    for (const row of storedAnchors) {
      const anchor = row.review_thread_anchors;
      const thread = threadsById.get(anchor.threadId);
      if (thread === undefined) {
        continue;
      }

      thread.anchor = {
        confidence: anchor.confidenceBasisPoints / 10000,
        currentLine: anchor.currentLine ?? undefined,
        currentPatchsetNumber: anchor.currentPatchsetNumber ?? undefined,
        currentPath: anchor.currentPath ?? undefined,
        originalLine: anchor.originalLine,
        originalPatchsetNumber: anchor.originalPatchsetNumber,
        originalPath: anchor.originalPath,
        side: anchor.side === "LEFT" ? "LEFT" : "RIGHT",
        sourceText: anchor.sourceText,
        status: thread.anchor.status,
      };
    }

    for (const row of comments) {
      const comment = row.review_thread_comments;
      const thread = threadsById.get(comment.threadId);
      if (thread === undefined) {
        continue;
      }

      thread.comments.push({
        author: { login: comment.authorLogin },
        body: comment.body,
        createdAt: comment.createdAt,
        githubUrl: comment.githubUrl ?? undefined,
        id: comment.id,
        mirroredToGithub: comment.mirroredToGithub,
        newSinceLastVisit: isNewSinceLastVisit(comment, visits[0]?.lastVisitedAt, viewerLogin),
      });
    }

    const attentionMembers =
      attention.length === 0
        ? buildDefaultAttentionMembers(pullRequest)
        : attention.map((member): ReviewAttentionMember => {
            return {
              addedAt: member.addedAt,
              login: member.userLogin,
              reason: member.reason,
            };
          });
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);
    const lastVisitedAt = visits[0]?.lastVisitedAt;
    const newCommentCount = comments.filter((row) =>
      isNewSinceLastVisit(row.review_thread_comments, lastVisitedAt, viewerLogin),
    ).length;

    const snapshot: ReviewSnapshot = {
      activity: {
        lastVisitedAt,
        newCommentCount,
      },
      attention: {
        isViewerTurn:
          viewerLogin !== undefined &&
          attentionMembers.some((member) => member.login === viewerLogin),
        members: attentionMembers,
      },
      capabilities: {
        limitations: [],
        mode: "indexed",
      },
      comparison: {
        additions,
        deletions,
        fileCount: files.length,
        fromPatchsetNumber: selectedFromPatchsetNumber,
        toPatchsetNumber: selectedToPatchset.patchsetNumber,
      },
      files,
      patchsets,
      pullRequest: {
        author: pullRequest.author,
        headSha: pullRequest.headSha,
        htmlUrl: `https://github.com/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.pullNumber}`,
        number: pullRequest.pullNumber,
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        state: "unknown",
        title: `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.pullNumber}`,
      },
      reviewState: buildReviewStateSummary(pullRequest.state),
      threads: [...threadsById.values()],
      viewer: viewerLogin === undefined ? undefined : { login: viewerLogin },
    };

    if (viewerLogin !== undefined) {
      await this.recordVisit(pullRequest.id, viewerLogin);
    }

    return snapshot;
  }

  async markFileReviewed(
    ref: ReviewPullRequestRef,
    viewerLogin: string,
    request: MarkReviewedRequest,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    await this.db
      .insert(reviewMarks)
      .values({
        filePath: request.filePath,
        markedAt: now,
        patchsetNumber: request.patchsetNumber,
        pullRequestId: pullRequest.id,
        userLogin: viewerLogin,
      })
      .onConflictDoUpdate({
        set: {
          markedAt: now,
          patchsetNumber: request.patchsetNumber,
        },
        target: [reviewMarks.pullRequestId, reviewMarks.userLogin, reviewMarks.filePath],
      });

    await this.recordVisit(pullRequest.id, viewerLogin, now);
    return true;
  }

  async recordPatchset(
    ref: ReviewPullRequestRef,
    input: ReviewPatchsetInput,
    now = input.createdAt,
  ): Promise<number | undefined> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return undefined;
    }

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ patchsetNumber: reviewPatchsets.patchsetNumber })
        .from(reviewPatchsets)
        .where(
          and(
            eq(reviewPatchsets.pullRequestId, pullRequest.id),
            eq(reviewPatchsets.headSha, input.headSha),
          ),
        )
        .limit(1);
      const previousPatchsets = await tx
        .select({ patchsetNumber: reviewPatchsets.patchsetNumber })
        .from(reviewPatchsets)
        .where(eq(reviewPatchsets.pullRequestId, pullRequest.id))
        .orderBy(asc(reviewPatchsets.patchsetNumber));
      const patchsetNumber =
        existing[0]?.patchsetNumber ?? (previousPatchsets.at(-1)?.patchsetNumber ?? 0) + 1;
      const previousPatchsetNumber = previousPatchsets
        .map((patchset) => patchset.patchsetNumber)
        .findLast((candidate) => candidate < patchsetNumber);
      const previousFiles =
        previousPatchsetNumber === undefined
          ? []
          : await tx
              .select()
              .from(reviewPatchsetFiles)
              .where(
                and(
                  eq(reviewPatchsetFiles.pullRequestId, pullRequest.id),
                  eq(reviewPatchsetFiles.patchsetNumber, previousPatchsetNumber),
                ),
              );
      const previousFilesByPath = new Map(previousFiles.map((file) => [file.filePath, file]));

      await tx
        .insert(reviewPatchsets)
        .values({
          actor: input.actor,
          baseSha: input.baseSha,
          createdAt: input.createdAt,
          eventType: input.eventType,
          forcePush: input.forcePush,
          headSha: input.headSha,
          parentSha: input.parentSha,
          patchsetNumber,
          pullRequestId: pullRequest.id,
          reconstructed: false,
        })
        .onConflictDoUpdate({
          set: {
            actor: input.actor,
            baseSha: input.baseSha ?? null,
            createdAt: input.createdAt,
            eventType: input.eventType,
            forcePush: input.forcePush,
            parentSha: input.parentSha ?? null,
            reconstructed: false,
          },
          target: [reviewPatchsets.pullRequestId, reviewPatchsets.patchsetNumber],
        });

      if (input.files.length > 0) {
        await tx
          .insert(reviewPatchsetFiles)
          .values(
            input.files.map((file) => {
              const previous = previousFilesByPath.get(file.path);
              return {
                additions: file.additions,
                deletions: file.deletions,
                filePath: file.path,
                patch: file.patch,
                patchsetNumber,
                previousFilePath: file.previousPath,
                pullRequestId: pullRequest.id,
                status: file.status,
                summary: {
                  changedSincePrior: didFileChangeSincePrior(file, previous),
                },
              };
            }),
          )
          .onConflictDoUpdate({
            set: {
              additions: sqlExcluded("additions"),
              deletions: sqlExcluded("deletions"),
              patch: sqlExcluded("patch"),
              previousFilePath: sqlExcluded("previous_file_path"),
              status: sqlExcluded("status"),
              summary: sqlExcluded("summary"),
            },
            target: [
              reviewPatchsetFiles.pullRequestId,
              reviewPatchsetFiles.patchsetNumber,
              reviewPatchsetFiles.filePath,
            ],
          });
      }

      await updateAttentionForPatchset(tx, pullRequest, input.actor ?? pullRequest.author, now);
      await relocateOpenAnchors(tx, pullRequest.id, patchsetNumber, input.files);
      return patchsetNumber;
    });
  }

  async passAttention(
    ref: ReviewPullRequestRef,
    actor: string,
    request: AttentionPassRequest,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(reviewAttentionMembers)
        .where(
          and(
            eq(reviewAttentionMembers.pullRequestId, pullRequest.id),
            eq(reviewAttentionMembers.userLogin, actor),
          ),
        );
      await tx
        .insert(reviewAttentionMembers)
        .values({
          addedAt: now,
          addedBy: actor,
          pullRequestId: pullRequest.id,
          reason: `Passed by ${actor}`,
          userLogin: request.targetLogin,
        })
        .onConflictDoUpdate({
          set: {
            addedAt: now,
            addedBy: actor,
            reason: `Passed by ${actor}`,
          },
          target: [reviewAttentionMembers.pullRequestId, reviewAttentionMembers.userLogin],
        });
      await tx.insert(reviewAttentionEvents).values({
        action: "pass",
        actor,
        createdAt: now,
        pullRequestId: pullRequest.id,
        targetLogin: request.targetLogin,
      });
    });
    return true;
  }

  async markNotMyTurn(
    ref: ReviewPullRequestRef,
    actor: string,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .delete(reviewAttentionMembers)
        .where(
          and(
            eq(reviewAttentionMembers.pullRequestId, pullRequest.id),
            eq(reviewAttentionMembers.userLogin, actor),
          ),
        );
      await tx.insert(reviewAttentionEvents).values({
        action: "not-my-turn",
        actor,
        createdAt: now,
        pullRequestId: pullRequest.id,
      });
    });
    return true;
  }

  async recordCreatedThread(
    ref: ReviewPullRequestRef,
    actor: string,
    request: CreateThreadRequest,
    options: {
      commentId: string;
      github?: GithubMirroredComment;
      marker: string;
      threadId: string;
      threadMarker: string;
    },
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    const patchsetNumber =
      request.patchsetNumber ?? (await this.loadLatestPatchsetNumber(pullRequest.id));
    const line = request.line ?? 1;
    const sourceText = getAnchorSourceText(request.sourceText, request.body);

    await this.db.transaction(async (tx) => {
      await tx.insert(reviewThreads).values({
        anchorStatus: "current",
        createdAt: now,
        githubFirstCommentId: options.github?.id,
        githubThreadNodeId: options.github?.threadNodeId,
        id: options.threadId,
        marker: options.threadMarker,
        ownerLogin: actor,
        pullRequestId: pullRequest.id,
        status: "open",
        updatedAt: now,
      });
      await tx.insert(reviewThreadAnchors).values({
        confidenceBasisPoints: 10000,
        currentLine: request.line,
        currentPatchsetNumber: patchsetNumber,
        currentPath: request.filePath,
        originalLine: line,
        originalPatchsetNumber: patchsetNumber,
        originalPath: request.filePath,
        side: request.side ?? "RIGHT",
        sourceText,
        threadId: options.threadId,
        tokenContext: tokenizeAnchorSource(sourceText),
      });
      await tx.insert(reviewThreadComments).values({
        authorLogin: actor,
        body: request.body,
        createdAt: now,
        githubCommentId: options.github?.id,
        githubNodeId: options.github?.nodeId,
        githubUrl: options.github?.url,
        id: options.commentId,
        marker: options.marker,
        mirroredToGithub: options.github !== undefined,
        threadId: options.threadId,
        updatedAt: now,
      });
      await tx
        .insert(reviewAttentionMembers)
        .values({
          addedAt: now,
          addedBy: actor,
          pullRequestId: pullRequest.id,
          reason: `Comment from ${actor}`,
          userLogin: pullRequest.author,
        })
        .onConflictDoUpdate({
          set: {
            addedAt: now,
            addedBy: actor,
            reason: `Comment from ${actor}`,
          },
          target: [reviewAttentionMembers.pullRequestId, reviewAttentionMembers.userLogin],
        });
      await tx.insert(reviewAttentionEvents).values({
        action: "comment-left",
        actor,
        createdAt: now,
        pullRequestId: pullRequest.id,
        targetLogin: pullRequest.author,
      });
    });

    await this.recordVisit(pullRequest.id, actor, now);
    return true;
  }

  async recordThreadReply(
    ref: ReviewPullRequestRef,
    actor: string,
    threadId: string,
    request: ReplyThreadRequest,
    options: {
      commentId: string;
      github?: GithubMirroredComment;
      marker: string;
    },
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    const thread = await this.loadThread(pullRequest.id, threadId);
    if (thread === undefined) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(reviewThreadComments).values({
        authorLogin: actor,
        body: request.body,
        createdAt: now,
        githubCommentId: options.github?.id,
        githubNodeId: options.github?.nodeId,
        githubUrl: options.github?.url,
        id: options.commentId,
        marker: options.marker,
        mirroredToGithub: options.github !== undefined,
        threadId,
        updatedAt: now,
      });
      await tx
        .update(reviewThreads)
        .set({
          status: "open",
          updatedAt: now,
        })
        .where(eq(reviewThreads.id, threadId));
      await tx
        .insert(reviewAttentionMembers)
        .values({
          addedAt: now,
          addedBy: actor,
          pullRequestId: pullRequest.id,
          reason: `Reply from ${actor}`,
          userLogin: pullRequest.author,
        })
        .onConflictDoUpdate({
          set: {
            addedAt: now,
            addedBy: actor,
            reason: `Reply from ${actor}`,
          },
          target: [reviewAttentionMembers.pullRequestId, reviewAttentionMembers.userLogin],
        });
      await tx.insert(reviewAttentionEvents).values({
        action: "comment-left",
        actor,
        createdAt: now,
        metadata: { threadId },
        pullRequestId: pullRequest.id,
        targetLogin: pullRequest.author,
      });
    });

    await this.recordVisit(pullRequest.id, actor, now);
    return true;
  }

  async resolveThread(
    ref: ReviewPullRequestRef,
    actor: string,
    threadId: string,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    const thread = await this.loadThread(pullRequest.id, threadId);
    if (thread === undefined) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(reviewThreads)
        .set({
          resolvedAt: now,
          resolvedBy: actor,
          status: "resolved",
          updatedAt: now,
        })
        .where(eq(reviewThreads.id, threadId));
      await tx
        .delete(reviewAttentionMembers)
        .where(
          and(
            eq(reviewAttentionMembers.pullRequestId, pullRequest.id),
            eq(reviewAttentionMembers.userLogin, pullRequest.author),
          ),
        );
      await tx.insert(reviewAttentionEvents).values({
        action: "thread-resolved",
        actor,
        createdAt: now,
        metadata: { threadId },
        pullRequestId: pullRequest.id,
        targetLogin: pullRequest.author,
      });
    });

    await this.recordVisit(pullRequest.id, actor, now);
    return true;
  }

  async loadThreadGithubRef(
    ref: ReviewPullRequestRef,
    threadId: string,
  ): Promise<ThreadGithubRef | undefined> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return undefined;
    }

    const thread = await this.loadThread(pullRequest.id, threadId);
    if (thread === undefined) {
      return undefined;
    }

    return {
      firstCommentId: thread.githubFirstCommentId ?? undefined,
      threadNodeId: thread.githubThreadNodeId ?? undefined,
    };
  }

  async ingestGithubReviewComment(
    ref: ReviewPullRequestRef,
    input: GithubReviewCommentIngestInput,
  ): Promise<boolean> {
    const pullRequest = await this.loadPullRequest(ref);
    if (pullRequest === undefined) {
      return false;
    }

    const patchsetNumber = await this.loadLatestPatchsetNumber(pullRequest.id);
    const threadMarker = serializeThreadMarker(input.threadId);
    const sourceText = getAnchorSourceText(input.sourceText, input.body);
    const githubFirstCommentId = input.githubRootCommentId ?? input.githubCommentId;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(reviewThreads)
        .values({
          anchorStatus: "current",
          createdAt: input.createdAt,
          githubFirstCommentId,
          githubThreadNodeId: input.githubThreadNodeId,
          id: input.threadId,
          marker: threadMarker,
          ownerLogin: input.authorLogin,
          pullRequestId: pullRequest.id,
          status: "open",
          updatedAt: input.createdAt,
        })
        .onConflictDoUpdate({
          set: {
            githubFirstCommentId,
            githubThreadNodeId: input.githubThreadNodeId ?? null,
            updatedAt: input.createdAt,
          },
          target: reviewThreads.id,
        });
      await tx
        .insert(reviewThreadAnchors)
        .values({
          confidenceBasisPoints: 10000,
          currentLine: input.line,
          currentPatchsetNumber: patchsetNumber,
          currentPath: input.path,
          originalLine: input.line ?? 1,
          originalPatchsetNumber: patchsetNumber,
          originalPath: input.path,
          side: input.side ?? "RIGHT",
          sourceText,
          threadId: input.threadId,
          tokenContext: tokenizeAnchorSource(sourceText),
        })
        .onConflictDoUpdate({
          set: {
            currentLine: input.line ?? null,
            currentPatchsetNumber: patchsetNumber,
            currentPath: input.path,
            sourceText,
            tokenContext: tokenizeAnchorSource(sourceText),
          },
          target: reviewThreadAnchors.threadId,
        });
      await tx
        .insert(reviewThreadComments)
        .values({
          authorLogin: input.authorLogin,
          body: input.body,
          createdAt: input.createdAt,
          githubCommentId: input.githubCommentId,
          githubNodeId: input.githubNodeId,
          githubUrl: input.githubUrl,
          marker: input.marker,
          mirroredToGithub: true,
          threadId: input.threadId,
          updatedAt: input.createdAt,
        })
        .onConflictDoUpdate({
          set: {
            body: input.body,
            githubCommentId: input.githubCommentId,
            githubNodeId: input.githubNodeId ?? null,
            githubUrl: input.githubUrl ?? null,
            mirroredToGithub: true,
            updatedAt: input.createdAt,
          },
          target: reviewThreadComments.marker,
        });
    });

    return true;
  }

  private async recordVisit(
    pullRequestId: string,
    viewerLogin: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.db
      .insert(reviewVisits)
      .values({
        lastVisitedAt: now,
        pullRequestId,
        userLogin: viewerLogin,
      })
      .onConflictDoUpdate({
        set: {
          lastVisitedAt: now,
        },
        target: [reviewVisits.pullRequestId, reviewVisits.userLogin],
      });
  }

  private async loadPullRequest(ref: ReviewPullRequestRef): Promise<PullRequestRow | undefined> {
    const rows = await this.db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.owner, ref.owner),
          eq(pullRequests.repo, ref.repo),
          eq(pullRequests.pullNumber, ref.pullNumber),
        ),
      )
      .limit(1);

    return rows[0];
  }

  private async loadLatestPatchsetNumber(pullRequestId: string): Promise<number> {
    const rows = await this.db
      .select({ patchsetNumber: reviewPatchsets.patchsetNumber })
      .from(reviewPatchsets)
      .where(eq(reviewPatchsets.pullRequestId, pullRequestId))
      .orderBy(asc(reviewPatchsets.patchsetNumber));

    return rows.at(-1)?.patchsetNumber ?? 1;
  }

  private async loadThread(
    pullRequestId: string,
    threadId: string,
  ): Promise<ReviewThreadRow | undefined> {
    const rows = await this.db
      .select()
      .from(reviewThreads)
      .where(and(eq(reviewThreads.pullRequestId, pullRequestId), eq(reviewThreads.id, threadId)))
      .limit(1);

    return rows[0];
  }
}

type PullRequestRow = typeof pullRequests.$inferSelect;
type ReviewMarkRow = typeof reviewMarks.$inferSelect;
type ReviewPatchsetFileRow = typeof reviewPatchsetFiles.$inferSelect;
type ReviewThreadCommentRow = typeof reviewThreadComments.$inferSelect;
type ReviewThreadRow = typeof reviewThreads.$inferSelect;

export type GithubMirroredComment = {
  id: number;
  nodeId?: string;
  threadNodeId?: string;
  url?: string;
};

export type ThreadGithubRef = {
  firstCommentId?: number;
  threadNodeId?: string;
};

function buildReconstructedPatchset(pullRequest: PullRequestRow): ReviewPatchset {
  return {
    actor: pullRequest.author,
    createdAt: pullRequest.lastProcessedAt,
    eventType: "reconstructed",
    forcePush: false,
    headSha: pullRequest.headSha,
    patchsetNumber: 1,
    reconstructed: true,
  };
}

function buildChangedAfterMarkByPath(
  files: ReviewPatchsetFileRow[],
  marks: ReviewMarkRow[],
): Map<string, boolean> {
  return new Map(
    marks.map((mark) => [
      mark.filePath,
      files.some(
        (file) =>
          file.patchsetNumber > mark.patchsetNumber &&
          (file.filePath === mark.filePath || file.previousFilePath === mark.filePath) &&
          fileChangedSincePrior(file),
      ),
    ]),
  );
}

function getChangedPathsInComparison(
  files: ReviewPatchsetFileRow[],
  fromPatchsetNumber: number,
  toPatchsetNumber: number,
): Set<string> {
  if (fromPatchsetNumber >= toPatchsetNumber) {
    return new Set(
      files.filter((file) => file.patchsetNumber === toPatchsetNumber).map((file) => file.filePath),
    );
  }

  return new Set(
    files
      .filter(
        (file) =>
          file.patchsetNumber > fromPatchsetNumber &&
          file.patchsetNumber <= toPatchsetNumber &&
          fileChangedSincePrior(file),
      )
      .flatMap((file) => [file.filePath, file.previousFilePath].filter(isString)),
  );
}

function clampPatchsetNumber(value: number, patchsets: ReviewPatchset[]): number {
  const numbers = patchsets.map((patchset) => patchset.patchsetNumber);
  if (numbers.length === 0) {
    return 1;
  }

  if (numbers.includes(value)) {
    return value;
  }

  return numbers.toSorted((left, right) => left - right)[0] ?? 1;
}

function buildReviewFiles(input: {
  changedAfterMarkByPath: Map<string, boolean>;
  files: ReviewPatchsetFileRow[];
  latestPatchsetNumber: number;
  marksByPath: Map<string, ReviewMarkRow>;
  stateRelevantFiles: string[];
}): ReviewFile[] {
  const files =
    input.files.length === 0
      ? input.stateRelevantFiles.map((path): ReviewPatchsetFileRow => {
          return {
            additions: 0,
            deletions: 0,
            filePath: path,
            patch: null,
            patchsetNumber: input.latestPatchsetNumber,
            previousFilePath: null,
            pullRequestId: "",
            status: "modified",
            summary: {},
          };
        })
      : input.files;

  return files.map((file) => {
    const mark = input.marksByPath.get(file.filePath);
    return {
      additions: file.additions,
      deletions: file.deletions,
      markState: getMarkState(
        mark,
        input.latestPatchsetNumber,
        input.changedAfterMarkByPath.get(file.filePath) ?? false,
      ),
      markedAt: mark?.markedAt,
      markedPatchsetNumber: mark?.patchsetNumber,
      patch: file.patch ?? undefined,
      path: file.filePath,
      previousPath: file.previousFilePath ?? undefined,
      status: file.status,
    };
  });
}

function didFileChangeSincePrior(
  file: ReviewPatchsetFileInput,
  previous: ReviewPatchsetFileRow | undefined,
): boolean {
  if (previous === undefined) {
    return true;
  }

  return (
    previous.additions !== file.additions ||
    previous.deletions !== file.deletions ||
    previous.patch !== (file.patch ?? null) ||
    previous.previousFilePath !== (file.previousPath ?? null) ||
    previous.status !== file.status
  );
}

function fileChangedSincePrior(file: ReviewPatchsetFileRow): boolean {
  const summary = file.summary as { changedSincePrior?: unknown };
  return summary.changedSincePrior !== false;
}

function isNewSinceLastVisit(
  comment: ReviewThreadCommentRow,
  lastVisitedAt: string | undefined,
  viewerLogin: string | undefined,
): boolean {
  if (lastVisitedAt === undefined || comment.authorLogin === viewerLogin) {
    return false;
  }

  return Date.parse(comment.createdAt) > Date.parse(lastVisitedAt);
}

async function updateAttentionForPatchset(
  tx: ClearanceDatabase,
  pullRequest: PullRequestRow,
  actor: string,
  now: string,
): Promise<void> {
  await tx
    .delete(reviewAttentionMembers)
    .where(
      and(
        eq(reviewAttentionMembers.pullRequestId, pullRequest.id),
        eq(reviewAttentionMembers.userLogin, pullRequest.author),
      ),
    );

  const reviewers = [
    ...new Set(pullRequest.state.assignments.flatMap((assignment) => assignment.reviewers)),
  ].toSorted(compareStrings);
  if (reviewers.length > 0) {
    await tx
      .insert(reviewAttentionMembers)
      .values(
        reviewers.map((reviewer) => ({
          addedAt: now,
          addedBy: actor,
          pullRequestId: pullRequest.id,
          reason: "New patchset needs review",
          userLogin: reviewer,
        })),
      )
      .onConflictDoUpdate({
        set: {
          addedAt: now,
          addedBy: actor,
          reason: "New patchset needs review",
        },
        target: [reviewAttentionMembers.pullRequestId, reviewAttentionMembers.userLogin],
      });
  }

  await tx.insert(reviewAttentionEvents).values({
    action: "patchset-pushed",
    actor,
    createdAt: now,
    pullRequestId: pullRequest.id,
  });
}

async function relocateOpenAnchors(
  tx: ClearanceDatabase,
  pullRequestId: string,
  patchsetNumber: number,
  files: ReviewPatchsetFileInput[],
): Promise<void> {
  const anchors = await tx
    .select({
      anchor: reviewThreadAnchors,
      thread: reviewThreads,
    })
    .from(reviewThreadAnchors)
    .innerJoin(reviewThreads, eq(reviewThreadAnchors.threadId, reviewThreads.id))
    .where(and(eq(reviewThreads.pullRequestId, pullRequestId), eq(reviewThreads.status, "open")));

  await Promise.all(
    anchors.map(async (row) => {
      const relocation = relocateAnchor(
        {
          currentLine: row.anchor.currentLine ?? undefined,
          currentPath: row.anchor.currentPath ?? undefined,
          originalLine: row.anchor.originalLine,
          originalPath: row.anchor.originalPath,
          sourceText: row.anchor.sourceText,
        },
        files.map((file) => ({ patch: file.patch, path: file.path })),
      );

      await tx
        .update(reviewThreadAnchors)
        .set({
          confidenceBasisPoints: Math.round(relocation.confidence * 10000),
          currentLine: relocation.currentLine ?? null,
          currentPatchsetNumber: relocation.status === "deleted" ? null : patchsetNumber,
          currentPath: relocation.currentPath ?? null,
        })
        .where(eq(reviewThreadAnchors.threadId, row.anchor.threadId));
      await tx
        .update(reviewThreads)
        .set({
          anchorStatus: relocation.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(reviewThreads.id, row.thread.id));
    }),
  );
}

function sqlExcluded(columnName: string) {
  return sql.raw(`excluded.${columnName}`);
}

function serializeThreadMarker(threadId: string): string {
  return `<!-- clearance-thread:v1\n${JSON.stringify({ threadId }, null, 2)}\n-->`;
}

function getMarkState(
  mark: ReviewMarkRow | undefined,
  latestPatchsetNumber: number,
  changedAfterMark: boolean,
): ReviewMarkState {
  if (mark === undefined) {
    return "unreviewed";
  }

  if (mark.patchsetNumber >= latestPatchsetNumber) {
    return "current";
  }

  return changedAfterMark ? "stale" : "current";
}

function getRelevantFilesFromState(state: PullRequestRow["state"]): string[] {
  return [
    ...new Set(state.requirements.flatMap((requirement) => requirement.relevantFiles ?? [])),
  ].toSorted(compareStrings);
}

function buildDefaultAttentionMembers(pullRequest: PullRequestRow): ReviewAttentionMember[] {
  const reviewers = [
    ...new Set(pullRequest.state.assignments.flatMap((assignment) => assignment.reviewers)),
  ].toSorted(compareStrings);

  return reviewers.map((login) => ({
    addedAt: pullRequest.lastProcessedAt,
    login,
    reason: "Requested review",
  }));
}

function buildReviewStateSummary(state: PullRequestRow["state"]): ReviewStateSummary {
  return {
    dryRun: state.dryRun === true,
    override:
      state.override === undefined
        ? undefined
        : {
            actor: state.override.actor,
            at: state.override.at,
          },
    requirements: state.requirements.map((requirement) => ({
      approvedBy: requirement.approvedBy,
      approvedHeadSha: requirement.approvedHeadSha,
      assignedReviewers: requirement.assignedReviewers ?? [],
      label: requirement.label,
      pendingSince: requirement.pendingSince,
      relevantFiles: requirement.relevantFiles ?? [],
      requiredCount: requirement.requiredCount,
      status: requirement.status,
    })),
    warnings: state.warnings.map((warning) => warning.message),
  };
}

function getDefaultFromPatchset(patchsets: ReviewPatchset[], marks: ReviewMarkRow[]): number {
  const latestMarkedPatchset = marks
    .map((mark) => mark.patchsetNumber)
    .toSorted((left, right) => right - left)[0];
  if (latestMarkedPatchset !== undefined) {
    return latestMarkedPatchset;
  }

  return patchsets[0]?.patchsetNumber ?? 1;
}

function getAnchorSourceText(sourceText: string | undefined, fallback: string): string {
  const trimmedSource = sourceText?.trim();
  return trimmedSource === undefined || trimmedSource === "" ? fallback : trimmedSource;
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

function tokenizeAnchorSource(source: string): string[] {
  return source
    .split(/\W+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 32);
}

function isString(value: string | null): value is string {
  return value !== null;
}
