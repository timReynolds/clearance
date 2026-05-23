import type { ReviewPullRequestRef, ReviewSnapshotOptions } from "./store.js";
import {
  loadPublicReviewSnapshot,
  type PublicPullRequestSnapshotOctokit,
} from "./public-snapshot.js";
import type { ReviewSnapshot } from "./types.js";

export type ReviewSnapshotStore = {
  loadSnapshot(
    ref: ReviewPullRequestRef,
    viewerLogin: string | undefined,
    options?: ReviewSnapshotOptions,
  ): Promise<ReviewSnapshot | undefined>;
};

export type LoadReviewSnapshotInput = {
  enhanceIndexedSnapshot?: (
    snapshot: ReviewSnapshot,
    ref: ReviewPullRequestRef,
  ) => Promise<ReviewSnapshot> | ReviewSnapshot;
  loadPublicSnapshot?: typeof loadPublicReviewSnapshot;
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
    return input.enhanceIndexedSnapshot === undefined
      ? indexedSnapshot
      : input.enhanceIndexedSnapshot(indexedSnapshot, input.ref);
  }

  const publicSnapshot = await (input.loadPublicSnapshot ?? loadPublicReviewSnapshot)(
    input.publicOctokit,
    input.ref,
    input.viewerLogin,
  );
  if (publicSnapshot !== undefined) {
    return publicSnapshot;
  }

  return undefined;
}
