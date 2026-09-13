import {
  listFileChangesBetweenCommits,
  type CommitCompareFileChange,
  type CommitCompareOctokit,
} from "../github/commit-compare.js";
import type { ReviewPullRequestRef, ReviewSnapshotOptions } from "./store.js";
import {
  loadPublicReviewSnapshot,
  type PublicPullRequestSnapshotOctokit,
} from "./public-snapshot.js";
import type { ReviewFile, ReviewFileStatus, ReviewSnapshot } from "./types.js";

export type ReviewSnapshotStore = {
  loadSnapshot(
    ref: ReviewPullRequestRef,
    viewerLogin: string | undefined,
    options?: ReviewSnapshotOptions,
  ): Promise<ReviewSnapshot | undefined>;
};

export type LoadReviewSnapshotInput = {
  getComparisonOctokit(ref: ReviewPullRequestRef): Promise<CommitCompareOctokit>;
  options?: ReviewSnapshotOptions;
  publicOctokit: PublicPullRequestSnapshotOctokit;
  ref: ReviewPullRequestRef;
  reviewStore: ReviewSnapshotStore;
  viewerLogin?: string;
};

export async function loadReviewSnapshot(
  input: LoadReviewSnapshotInput,
): Promise<ReviewSnapshot | undefined> {
  const indexedSnapshot = await input.reviewStore.loadSnapshot(
    input.ref,
    input.viewerLogin,
    input.options,
  );
  if (indexedSnapshot !== undefined) {
    return addGithubPatchsetComparison(indexedSnapshot, input);
  }

  return loadPublicReviewSnapshot(input.publicOctokit, input.ref, input.viewerLogin);
}

async function addGithubPatchsetComparison(
  snapshot: ReviewSnapshot,
  input: LoadReviewSnapshotInput,
): Promise<ReviewSnapshot> {
  const fromPatchset = snapshot.patchsets.find(
    (patchset) => patchset.patchsetNumber === snapshot.comparison.fromPatchsetNumber,
  );
  const toPatchset = snapshot.patchsets.find(
    (patchset) => patchset.patchsetNumber === snapshot.comparison.toPatchsetNumber,
  );
  if (
    fromPatchset === undefined ||
    toPatchset === undefined ||
    fromPatchset.patchsetNumber >= toPatchset.patchsetNumber
  ) {
    return snapshot;
  }

  const ref = input.ref;
  try {
    const octokit = await input.getComparisonOctokit(ref);
    const files = await listFileChangesBetweenCommits(octokit, {
      base: fromPatchset.headSha,
      head: toPatchset.headSha,
      owner: ref.owner,
      repo: ref.repo,
    });

    return buildComparedSnapshot(snapshot, files);
  } catch (error) {
    console.warn(
      {
        error: error instanceof Error ? error.message : "GitHub patchset comparison failed",
        fromPatchsetNumber: fromPatchset.patchsetNumber,
        pullNumber: ref.pullNumber,
        repository: `${ref.owner}/${ref.repo}`,
        toPatchsetNumber: toPatchset.patchsetNumber,
      },
      "failed to load GitHub patchset comparison",
    );

    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        limitations: appendUnique(
          snapshot.capabilities.limitations,
          "Exact GitHub commit comparison is unavailable; showing the indexed patchset snapshot.",
        ),
      },
    };
  }
}

function buildComparedSnapshot(
  snapshot: ReviewSnapshot,
  fileChanges: CommitCompareFileChange[],
): ReviewSnapshot {
  const files = fileChanges.map((file) => buildComparedReviewFile(snapshot.files, file));

  return {
    ...snapshot,
    comparison: {
      ...snapshot.comparison,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      fileCount: files.length,
    },
    files,
  };
}

function buildComparedReviewFile(
  indexedFiles: ReviewFile[],
  file: CommitCompareFileChange,
): ReviewFile {
  const indexedFile =
    indexedFiles.find((candidate) => candidate.path === file.filename) ??
    indexedFiles.find((candidate) => candidate.path === file.previousFilename);

  return {
    additions: file.additions,
    deletions: file.deletions,
    markState: indexedFile?.markState ?? "unreviewed",
    markedAt: indexedFile?.markedAt,
    markedPatchsetNumber: indexedFile?.markedPatchsetNumber,
    patch: buildComparedFilePatch(file),
    path: file.filename,
    previousPath: file.previousFilename,
    status: mapComparedFileStatus(file.status),
  };
}

function buildComparedFilePatch(file: CommitCompareFileChange): string | undefined {
  if (file.patch === undefined || file.patch.trim() === "") {
    return undefined;
  }

  if (file.patch.startsWith("diff --git")) {
    return file.patch;
  }

  const previousPath = file.previousFilename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : `a/${previousPath}`;
  const newPath = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;

  return [
    `diff --git a/${previousPath} b/${file.filename}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    file.patch,
  ].join("\n");
}

function mapComparedFileStatus(status: string): ReviewFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "changed":
    case "copied":
    case "modified":
    default:
      return "modified";
  }
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
