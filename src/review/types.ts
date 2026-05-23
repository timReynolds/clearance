export type PatchsetEventType =
  | "opened"
  | "synchronize"
  | "force_push"
  | "base_update"
  | "reconstructed";

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "unchanged";

export type ReviewMarkState = "unreviewed" | "current" | "stale";

export type ReviewThreadStatus = "open" | "resolved";

export type AnchorStatus = "current" | "moved" | "uncertain" | "deleted";

export type ReviewAttentionAction =
  | "patchset-pushed"
  | "comment-left"
  | "thread-resolved"
  | "pass"
  | "not-my-turn";

export type ReviewUser = {
  avatarUrl?: string;
  login: string;
};

export type ReviewPullRequestSummary = {
  author: string;
  headSha: string;
  htmlUrl: string;
  number: number;
  owner: string;
  repo: string;
  state: "open" | "closed" | "merged" | "unknown";
  title: string;
};

export type ReviewPatchset = {
  actor?: string;
  baseSha?: string;
  createdAt: string;
  eventType: PatchsetEventType;
  forcePush: boolean;
  headSha: string;
  parentSha?: string;
  patchsetNumber: number;
  reconstructed: boolean;
};

export type ReviewFile = {
  additions: number;
  deletions: number;
  markState: ReviewMarkState;
  markedAt?: string;
  markedPatchsetNumber?: number;
  patch?: string;
  path: string;
  previousPath?: string;
  status: ReviewFileStatus;
};

export type ReviewComment = {
  author: ReviewUser;
  body: string;
  createdAt: string;
  githubUrl?: string;
  id: string;
  mirroredToGithub: boolean;
  newSinceLastVisit: boolean;
};

export type ReviewAnchor = {
  confidence: number;
  currentLine?: number;
  currentPatchsetNumber?: number;
  currentPath?: string;
  originalLine: number;
  originalPatchsetNumber: number;
  originalPath: string;
  side: "LEFT" | "RIGHT";
  sourceText: string;
  status: AnchorStatus;
};

export type ReviewThread = {
  anchor: ReviewAnchor;
  comments: ReviewComment[];
  id: string;
  owner: ReviewUser;
  status: ReviewThreadStatus;
};

export type ReviewAttentionMember = {
  addedAt: string;
  login: string;
  reason: string;
};

export type ReviewAttention = {
  isViewerTurn: boolean;
  members: ReviewAttentionMember[];
};

export type ReviewComparison = {
  additions: number;
  deletions: number;
  fileCount: number;
  fromPatchsetNumber: number;
  toPatchsetNumber: number;
};

export type ReviewActivity = {
  lastVisitedAt?: string;
  newCommentCount: number;
};

export type ReviewSnapshotMode = "demo" | "indexed" | "public";

export type ReviewSnapshotCapabilities = {
  limitations: string[];
  mode: ReviewSnapshotMode;
};

export type ReviewSnapshot = {
  activity: ReviewActivity;
  attention: ReviewAttention;
  capabilities: ReviewSnapshotCapabilities;
  comparison: ReviewComparison;
  files: ReviewFile[];
  patchsets: ReviewPatchset[];
  pullRequest: ReviewPullRequestSummary;
  threads: ReviewThread[];
  viewer?: ReviewUser;
};

export type MarkReviewedRequest = {
  filePath: string;
  patchsetNumber: number;
  pullRequestNodeId?: string;
};

export type AttentionPassRequest = {
  targetLogin: string;
};

export type CreateThreadRequest = {
  body: string;
  commitSha: string;
  filePath: string;
  line?: number;
  patchsetNumber?: number;
  side?: "LEFT" | "RIGHT";
  sourceText?: string;
};

export type ReplyThreadRequest = {
  body: string;
};

export type SubmitReviewRequest = {
  body?: string;
};
