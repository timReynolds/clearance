import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import type {
  DiffIndicators,
  DiffLineAnnotation,
  LineDiffTypes,
  SelectedLineRange,
} from "@pierre/diffs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  GitBranch,
  Github,
  LogIn,
  LogOut,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
} from "lucide-react";

import type { ReviewFile, ReviewSnapshot, ReviewThread } from "../src/review/types";
// oxlint-disable-next-line import/no-unassigned-import
import "./styles.css";

const defaultViewerLogin = readLocalPreference("clearance.viewer") ?? "tim";
const defaultDiffOptions: DiffViewerOptions = {
  backgrounds: true,
  diffStyle: "unified",
  indicators: "bars",
  lineDiffType: "word-alt",
  lineNumbers: true,
  wrapping: false,
};

function App() {
  const route = parseReviewRoute(window.location.pathname);
  const [viewerLogin, setViewerLogin] = useState(defaultViewerLogin);
  const [me, setMe] = useState<MeResponse | undefined>();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [draftComments, setDraftComments] = useState<Record<string, string>>({});
  const [reviewBody, setReviewBody] = useState("");
  const [commentTarget, setCommentTarget] = useState<CommentTarget | undefined>();
  const [passTarget, setPassTarget] = useState("");
  const [actionError, setActionError] = useState<string | undefined>();
  const [diffOptions, setDiffOptions] = useState(readDiffOptions);
  const [tokenHover, setTokenHover] = useState<TokenHover | undefined>();
  const [comparisonSelection, setComparisonSelection] = useState<{
    from?: number;
    to?: number;
  }>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    writeLocalPreference("clearance.viewer", viewerLogin);
  }, [viewerLogin]);

  useEffect(() => {
    writeLocalPreference("clearance.diffOptions", JSON.stringify(diffOptions));
  }, [diffOptions]);

  useEffect(() => {
    let cancelled = false;
    requestJson<MeResponse>(`/api/me?returnTo=${encodeURIComponent(window.location.pathname)}`, {
      headers: { "x-clearance-user": viewerLogin },
    })
      .then((nextMe) => {
        if (cancelled) {
          return;
        }

        setMe(nextMe);
        if (
          nextMe.authenticated &&
          nextMe.viewer?.login !== undefined &&
          nextMe.viewer.login !== viewerLogin
        ) {
          setViewerLogin(nextMe.viewer.login);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMe({ authenticated: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [viewerLogin]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    requestJson<ReviewSnapshot>(buildReviewApiUrl(route, comparisonSelection), {
      headers: { "x-clearance-user": viewerLogin },
    })
      .then((nextSnapshot) => {
        if (cancelled) {
          return;
        }

        setSnapshot(nextSnapshot);
        setSelectedPath((current) => current ?? nextSnapshot.files[0]?.path);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSnapshot(undefined);
          setLoadError(getClientErrorMessage(error, "Review unavailable"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    comparisonSelection.from,
    comparisonSelection.to,
    route.owner,
    route.pullNumber,
    route.repo,
    viewerLogin,
  ]);

  if (snapshot === undefined) {
    return (
      <main className="boot">
        <RefreshCw className={loading ? "spin" : ""} size={18} />
        <span>{loading ? "Loading review" : (loadError ?? "Review unavailable")}</span>
      </main>
    );
  }

  const hasPatchsetControls = snapshot.patchsets.length > 1;
  const canShowTurnIndicator =
    me?.authenticated === true && snapshot.capabilities.mode === "indexed";
  const canUseReviewerActions = canShowTurnIndicator && snapshot.attention.isViewerTurn;
  const canMarkReviewed = me?.authenticated === true && snapshot.capabilities.mode === "indexed";
  const threadStatsByPath = buildFileThreadStatsByPath(snapshot.threads);

  function actionHeaders(hasJsonBody = false): Record<string, string> {
    return {
      ...(hasJsonBody ? { "content-type": "application/json" } : {}),
      ...(me?.csrfToken === undefined ? {} : { "x-clearance-csrf": me.csrfToken }),
      "x-clearance-user": viewerLogin,
    };
  }

  async function refreshReview(): Promise<void> {
    const response = await request(buildReviewApiUrl(route, comparisonSelection), {
      headers: actionHeaders(),
    });
    if (response.ok) {
      const nextSnapshot = (await response.json()) as ReviewSnapshot;
      setSnapshot(nextSnapshot);
      setSelectedPath((current) => current ?? nextSnapshot.files[0]?.path);
    }
  }

  function selectComparison(from: number, to: number): void {
    if (
      snapshot?.comparison.fromPatchsetNumber === from &&
      snapshot.comparison.toPatchsetNumber === to
    ) {
      return;
    }

    setComparisonSelection({ from, to });
    setSelectedPath(undefined);
    setCommentTarget(undefined);
  }

  function jumpToFile(path: string): void {
    setSelectedPath(path);
    window.requestAnimationFrame(() => {
      document.getElementById(fileSectionId(path))?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  function updateDraftComment(path: string, value: string): void {
    setDraftComments((current) => ({
      ...current,
      [path]: value,
    }));
  }

  function clearDraftComment(path: string): void {
    setDraftComments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  function updateDiffOption<T extends keyof DiffViewerOptions>(
    key: T,
    value: DiffViewerOptions[T],
  ): void {
    setDiffOptions((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function postJson(path: string, body?: unknown): Promise<ClientResponse> {
    return request(`/api/review/${route.owner}/${route.repo}/pull/${route.pullNumber}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: actionHeaders(body !== undefined),
      method: "POST",
    });
  }

  async function markReviewed(file: ReviewFile): Promise<void> {
    setActionError(undefined);
    const response = await postJson("/marks", {
      filePath: file.path,
      patchsetNumber: snapshot?.comparison.toPatchsetNumber ?? 1,
    });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    setSnapshot((current) =>
      current === undefined
        ? current
        : {
            ...current,
            files: current.files.map((entry) =>
              entry.path === file.path
                ? {
                    ...entry,
                    markState: "current",
                    markedAt: new Date().toISOString(),
                    markedPatchsetNumber: current.comparison.toPatchsetNumber,
                  }
                : entry,
            ),
          },
    );
  }

  async function passAttention(): Promise<void> {
    const targetLogin = passTarget.trim();
    if (targetLogin === "") {
      setActionError("Pick someone to pass to.");
      return;
    }

    setActionError(undefined);
    const response = await postJson("/attention/pass", { targetLogin });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    setPassTarget("");
    await refreshReview();
  }

  async function createThread(
    file: ReviewFile,
    anchor: ThreadAnchorMode = "selected-line",
  ): Promise<void> {
    const currentSnapshot = snapshot;
    const draftComment = draftComments[file.path] ?? "";
    if (currentSnapshot === undefined || draftComment.trim() === "") {
      return;
    }

    const useLineTarget = anchor === "selected-line" && commentTarget?.path === file.path;
    setSelectedPath(file.path);
    setActionError(undefined);
    const response = await postJson("/threads", {
      body: draftComment.trim(),
      commitSha: currentSnapshot.pullRequest.headSha,
      filePath: file.path,
      line: useLineTarget ? commentTarget.line : undefined,
      patchsetNumber: currentSnapshot.comparison.toPatchsetNumber,
      side: useLineTarget ? commentTarget.side : undefined,
      sourceText: useLineTarget ? commentTarget.sourceText : file.patch?.slice(0, 600),
    });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    clearDraftComment(file.path);
    setCommentTarget(undefined);
    await refreshReview();
  }

  async function replyToThread(threadId: string, body: string): Promise<void> {
    if (body.trim() === "") {
      return;
    }

    setActionError(undefined);
    const response = await postJson(`/threads/${threadId}/replies`, { body: body.trim() });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    await refreshReview();
  }

  async function resolveThread(threadId: string): Promise<void> {
    setActionError(undefined);
    const response = await postJson(`/threads/${threadId}/resolve`);
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    const payload = (await response.json()) as { githubResolved?: boolean; persisted?: boolean };
    setSnapshot((current) =>
      current === undefined
        ? current
        : {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === threadId ? { ...thread, status: "resolved" } : thread,
            ),
          },
    );
    if (payload.persisted === true) {
      await refreshReview();
    }
  }

  async function submitReview(event: ReviewEvent): Promise<void> {
    const body = reviewBody.trim();
    if (event !== "APPROVE" && body === "") {
      setActionError("Add a review summary first.");
      return;
    }

    setActionError(undefined);
    const response = await postJson("/reviews", {
      body: body === "" ? undefined : body,
      event,
    });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    setReviewBody("");
    await refreshReview();
  }

  return (
    <Tooltip.Provider>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span>Clearance</span>
          </div>
          <div className="pr-title">
            <a
              href={`https://github.com/${snapshot.pullRequest.owner}/${snapshot.pullRequest.repo}`}
            >
              {snapshot.pullRequest.owner}/{snapshot.pullRequest.repo}
            </a>
            <ChevronRight size={14} />
            <a href={snapshot.pullRequest.htmlUrl}>#{snapshot.pullRequest.number}</a>
            <span>{snapshot.pullRequest.title}</span>
          </div>
          <div className="top-actions">
            <a className="github-open" href={snapshot.pullRequest.htmlUrl}>
              <Github size={16} />
              <span>Open in GitHub</span>
              <ExternalLink size={13} />
            </a>
            {me?.authenticated ? (
              <AccountMenu
                avatarUrl={me.viewer?.avatarUrl}
                login={me.viewer?.login ?? viewerLogin}
              />
            ) : me?.loginUrl !== undefined ? (
              <a className="secondary-button" href={me.loginUrl}>
                <LogIn size={15} />
                Sign in
              </a>
            ) : (
              <span className="secondary-button disabled">
                <Github size={15} />
                Public
              </span>
            )}
          </div>
        </header>

        <section className="statebar">
          <div className="state-summary">
            {canShowTurnIndicator ? (
              <span className={`turn-indicator ${snapshot.attention.isViewerTurn ? "active" : ""}`}>
                <i />
                {snapshot.attention.isViewerTurn ? "Your turn" : "Not your turn"}
              </span>
            ) : null}
            <StatusPill label={snapshot.capabilities.mode} tone="cool" />
            {hasPatchsetControls ? (
              <StatusPill label={`${snapshot.patchsets.length} patchsets`} tone="cool" />
            ) : null}
            <StatusPill label={`${snapshot.comparison.fileCount} files`} tone="muted" />
            {snapshot.activity.newCommentCount > 0 ? (
              <StatusPill label={`${snapshot.activity.newCommentCount} new replies`} tone="hot" />
            ) : null}
            <span className="state-meta">
              {hasPatchsetControls
                ? `PS ${snapshot.comparison.fromPatchsetNumber} to PS ${snapshot.comparison.toPatchsetNumber}`
                : "Current diff"}
              <b> +{snapshot.comparison.additions}</b>
              <b> -{snapshot.comparison.deletions}</b>
            </span>
          </div>
          {canUseReviewerActions ? (
            <div className="state-actions">
              {actionError === undefined ? null : (
                <span className="state-error">{actionError}</span>
              )}
              <details className="review-menu">
                <summary className="review-button">
                  <Check size={15} />
                  Review
                  <ChevronDown size={14} />
                </summary>
                <div className="review-popover">
                  <textarea
                    aria-label="Review summary"
                    onChange={(event) => setReviewBody(event.target.value)}
                    placeholder="Add a review summary"
                    value={reviewBody}
                  />
                  <div className="review-options">
                    <button onClick={() => void submitReview("COMMENT")}>
                      <MessageSquare size={15} />
                      Comment
                    </button>
                    <button onClick={() => void submitReview("APPROVE")}>
                      <Check size={15} />
                      Approve
                    </button>
                    <button onClick={() => void submitReview("REQUEST_CHANGES")}>
                      <CircleAlert size={15} />
                      Request changes
                    </button>
                  </div>
                </div>
              </details>
              <details className="pass-menu">
                <summary className="review-button">
                  <Send size={15} />
                  Pass
                  <ChevronDown size={14} />
                </summary>
                <div className="pass-popover">
                  <label>
                    <span>Pass to</span>
                    <input
                      aria-label="Pass attention to"
                      onChange={(event) => setPassTarget(event.target.value)}
                      placeholder="Reviewer login"
                      value={passTarget}
                    />
                  </label>
                  <button onClick={() => void passAttention()}>
                    <Send size={15} />
                    Pass
                  </button>
                </div>
              </details>
            </div>
          ) : null}
        </section>

        <div className="review-grid">
          <aside className="file-pane">
            <ReviewFileList
              files={snapshot.files}
              onSelect={jumpToFile}
              selectedPath={selectedPath}
              threadStatsByPath={threadStatsByPath}
            />
          </aside>

          <main className="diff-pane">
            <DiffToolbar
              fileCount={snapshot.files.length}
              onChange={updateDiffOption}
              options={diffOptions}
            />
            {hasPatchsetControls ? (
              <PatchsetRail onSelectComparison={selectComparison} snapshot={snapshot} />
            ) : null}
            {snapshot.files.length === 0 ? (
              <div className="empty-state">No changed files</div>
            ) : (
              snapshot.files.map((file) => (
                <ReviewFileSection
                  actionError={file.path === selectedPath ? actionError : undefined}
                  canMarkReviewed={canMarkReviewed}
                  commentTarget={commentTarget}
                  diffOptions={diffOptions}
                  draftComment={draftComments[file.path] ?? ""}
                  file={file}
                  key={file.path}
                  onClearCommentTarget={() => setCommentTarget(undefined)}
                  onCreateThread={createThread}
                  onDraftCommentChange={(value) => updateDraftComment(file.path, value)}
                  onMarkReviewed={markReviewed}
                  onReply={replyToThread}
                  onResolve={resolveThread}
                  onSelectFile={setSelectedPath}
                  selected={file.path === selectedPath}
                  setTokenHover={setTokenHover}
                  setCommentTarget={setCommentTarget}
                  snapshot={snapshot}
                />
              ))
            )}
          </main>
        </div>
        {tokenHover === undefined ? null : <TokenHoverCard hover={tokenHover} />}
      </div>
    </Tooltip.Provider>
  );
}

function ReviewFileList(props: {
  files: ReviewFile[];
  onSelect(path: string): void;
  selectedPath?: string;
  threadStatsByPath: Map<string, FileThreadStats>;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const files =
    normalizedQuery === ""
      ? props.files
      : props.files.filter((file) => file.path.toLowerCase().includes(normalizedQuery));

  return (
    <>
      <label className="file-filter">
        <Search size={14} />
        <input
          aria-label="Filter changed files"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter changed files"
          value={query}
        />
      </label>
      <div className="file-list">
        {files.length === 0 ? (
          <div className="empty-file-list">No matching files</div>
        ) : (
          <table className="file-table">
            <colgroup>
              <col className="file-column-path" />
              <col className="file-column-comments" />
              <col className="file-column-state" />
              <col className="file-column-delta" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Comments</th>
                <th scope="col">State</th>
                <th scope="col">Delta</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  className={[
                    "file-table-row",
                    file.path === props.selectedPath ? "selected" : "",
                    file.markState,
                  ].join(" ")}
                  key={file.path}
                >
                  <td className="file-name-cell">
                    <span className={`file-status-badge ${file.status}`}>
                      {getFileStatusCode(file.status)}
                    </span>
                    <button
                      className="file-name-button"
                      onClick={() => props.onSelect(file.path)}
                      type="button"
                    >
                      {file.path}
                    </button>
                  </td>
                  <td>{formatFileThreadStats(props.threadStatsByPath.get(file.path))}</td>
                  <td>
                    <span className={`file-state ${file.markState}`}>
                      {formatMarkState(file.markState)}
                    </span>
                  </td>
                  <td className="file-delta">
                    <span>+{file.additions}</span>
                    <span>-{file.deletions}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function DiffToolbar({
  fileCount,
  onChange,
  options,
}: {
  fileCount: number;
  onChange<T extends keyof DiffViewerOptions>(key: T, value: DiffViewerOptions[T]): void;
  options: DiffViewerOptions;
}) {
  return (
    <div className="diff-toolbar">
      <div className="diff-toolbar-title">
        <strong>Diff viewer</strong>
        <span>{fileCount} files</span>
      </div>
      <details className="diff-options-menu">
        <summary className="review-button">
          <SlidersHorizontal size={15} />
          Options
          <ChevronDown size={14} />
        </summary>
        <div className="diff-options-popover">
          <fieldset>
            <legend>Indicators</legend>
            <SegmentedControl
              onChange={(value) => onChange("indicators", value as DiffViewerOptions["indicators"])}
              options={[
                { label: "Bars", value: "bars" },
                { label: "Classic", value: "classic" },
                { label: "None", value: "none" },
              ]}
              value={options.indicators}
            />
          </fieldset>
          <fieldset>
            <legend>Layout</legend>
            <SegmentedControl
              onChange={(value) => onChange("diffStyle", value as DiffViewerOptions["diffStyle"])}
              options={[
                { label: "Unified", value: "unified" },
                { label: "Split", value: "split" },
              ]}
              value={options.diffStyle}
            />
          </fieldset>
          <label className="select-setting">
            <span>Inline changes</span>
            <select
              onChange={(event) =>
                onChange("lineDiffType", event.target.value as DiffViewerOptions["lineDiffType"])
              }
              value={options.lineDiffType}
            >
              <option value="word-alt">Word-Alt</option>
              <option value="word">Word</option>
              <option value="char">Character</option>
              <option value="none">None</option>
            </select>
          </label>
          <ToggleSetting
            checked={options.backgrounds}
            label="Backgrounds"
            onChange={(checked) => onChange("backgrounds", checked)}
          />
          <ToggleSetting
            checked={options.wrapping}
            label="Wrapping"
            onChange={(checked) => onChange("wrapping", checked)}
          />
          <ToggleSetting
            checked={options.lineNumbers}
            label="Line numbers"
            onChange={(checked) => onChange("lineNumbers", checked)}
          />
        </div>
      </details>
    </div>
  );
}

function SegmentedControl({
  onChange,
  options,
  value,
}: {
  onChange(value: string): void;
  options: { label: string; value: string }[];
  value: string;
}) {
  return (
    <div className="segmented-control">
      {options.map((option) => (
        <button
          className={option.value === value ? "active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleSetting({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="toggle-setting">
      <span>{label}</span>
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
    </label>
  );
}

type FileThreadStats = {
  commentCount: number;
  openThreadCount: number;
};

function buildFileThreadStatsByPath(
  threads: ReviewSnapshot["threads"],
): Map<string, FileThreadStats> {
  const statsByPath = new Map<string, FileThreadStats>();

  for (const thread of threads) {
    const path = thread.anchor.currentPath ?? thread.anchor.originalPath;
    const currentStats = statsByPath.get(path) ?? {
      commentCount: 0,
      openThreadCount: 0,
    };
    currentStats.commentCount += thread.comments.length;
    if (thread.status === "open") {
      currentStats.openThreadCount += 1;
    }
    statsByPath.set(path, currentStats);
  }

  return statsByPath;
}

function formatFileThreadStats(stats: FileThreadStats | undefined): string {
  if (stats === undefined || stats.commentCount === 0) {
    return "";
  }

  const commentLabel = `${stats.commentCount} ${stats.commentCount === 1 ? "comment" : "comments"}`;
  if (stats.openThreadCount === 0) {
    return commentLabel;
  }

  return `${commentLabel} (${stats.openThreadCount} unresolved)`;
}

function getFileStatusCode(status: ReviewFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    case "renamed":
      return "R";
    case "unchanged":
      return "U";
  }
}

function formatMarkState(markState: ReviewFile["markState"]): string {
  switch (markState) {
    case "current":
      return "Reviewed";
    case "stale":
      return "Stale";
    case "unreviewed":
      return "Open";
  }
}

function fileSectionId(path: string): string {
  return `file-${encodeURIComponent(path)}`;
}

function ReviewFileSection({
  actionError,
  canMarkReviewed,
  commentTarget,
  diffOptions,
  draftComment,
  file,
  onClearCommentTarget,
  onCreateThread,
  onDraftCommentChange,
  onMarkReviewed,
  onReply,
  onResolve,
  onSelectFile,
  selected,
  setTokenHover,
  setCommentTarget,
  snapshot,
}: {
  actionError?: string;
  canMarkReviewed: boolean;
  commentTarget?: CommentTarget;
  diffOptions: DiffViewerOptions;
  draftComment: string;
  file: ReviewFile;
  onClearCommentTarget(): void;
  onCreateThread(file: ReviewFile, anchor?: ThreadAnchorMode): Promise<void>;
  onDraftCommentChange(value: string): void;
  onMarkReviewed(file: ReviewFile): Promise<void>;
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
  onSelectFile(path: string): void;
  selected: boolean;
  setTokenHover: Dispatch<SetStateAction<TokenHover | undefined>>;
  setCommentTarget: Dispatch<SetStateAction<CommentTarget | undefined>>;
  snapshot: ReviewSnapshot;
}) {
  const lineAnnotations = buildDiffLineAnnotations(file, snapshot.threads, commentTarget);

  return (
    <section
      className={`file-diff-section ${selected ? "selected" : ""}`}
      id={fileSectionId(file.path)}
    >
      <div className="file-header">
        <div className="file-header-main">
          <span className={`file-status-badge ${file.status}`}>
            {getFileStatusCode(file.status)}
          </span>
          <div className="file-header-title">
            <strong>{file.path}</strong>
          </div>
        </div>
        <div className="file-header-actions">
          <details className="file-comment-menu">
            <summary className="file-comment-button" onClick={() => onSelectFile(file.path)}>
              <MessageSquare size={15} />
              Comment
            </summary>
            <div className="file-comment-popover">
              <textarea
                aria-label={`New file review comment on ${file.path}`}
                onChange={(event) => onDraftCommentChange(event.target.value)}
                onFocus={() => {
                  onSelectFile(file.path);
                  onClearCommentTarget();
                }}
                placeholder="Leave a file-level review thread"
                value={draftComment}
              />
              <div className="file-comment-submit">
                {actionError === undefined ? null : (
                  <span className="action-error">{actionError}</span>
                )}
                <button
                  className="primary-button"
                  disabled={draftComment.trim() === ""}
                  onClick={() => void onCreateThread(file, "file")}
                  type="button"
                >
                  <MessageSquare size={15} />
                  Comment
                </button>
              </div>
            </div>
          </details>
          <span className="file-header-delta">
            <b>-{file.deletions}</b>
            <b>+{file.additions}</b>
          </span>
          {canMarkReviewed ? (
            <button
              className={`viewed-button ${file.markState === "current" ? "viewed" : ""}`}
              onClick={() => void onMarkReviewed(file)}
              title="Mark this file as reviewed"
              type="button"
            >
              <span />
              Viewed
            </button>
          ) : null}
        </div>
      </div>
      <div className="diff-scroll">
        {file.patch === undefined ? (
          <pre className="no-patch">Patch content has not been indexed yet.</pre>
        ) : (
          <PatchDiff
            disableWorkerPool
            options={{
              diffIndicators: diffOptions.indicators,
              diffStyle: diffOptions.diffStyle,
              disableBackground: !diffOptions.backgrounds,
              disableFileHeader: true,
              disableLineNumbers: !diffOptions.lineNumbers,
              enableGutterUtility: true,
              hunkSeparators: "line-info-basic",
              lineHoverHighlight: "both",
              lineDiffType: diffOptions.lineDiffType,
              onTokenEnter: (token, event) =>
                setTokenHover({
                  end: token.lineCharEnd,
                  lineNumber: token.lineNumber,
                  side: token.side,
                  start: token.lineCharStart,
                  text: token.tokenText,
                  x: event.clientX,
                  y: event.clientY,
                }),
              onTokenLeave: () => setTokenHover(undefined),
              overflow: diffOptions.wrapping ? "wrap" : "scroll",
              theme: {
                dark: "pierre-dark",
                light: "pierre-light",
              },
              useTokenTransformer: true,
            }}
            patch={file.patch}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <DiffLineAnnotationPanel
                actionError={actionError}
                annotation={annotation}
                draftComment={draftComment}
                file={file}
                onClearCommentTarget={onClearCommentTarget}
                onCreateThread={onCreateThread}
                onDraftCommentChange={onDraftCommentChange}
                onReply={onReply}
                onResolve={onResolve}
              />
            )}
            renderGutterUtility={(getHoveredLine) => (
              <button
                aria-label="Comment on line"
                className="gutter-comment"
                onClick={() => {
                  const hoveredLine = getHoveredLine();
                  if (hoveredLine !== undefined) {
                    onSelectFile(file.path);
                    setCommentTargetFromRange(
                      file,
                      {
                        end: hoveredLine.lineNumber,
                        endSide: hoveredLine.side,
                        side: hoveredLine.side,
                        start: hoveredLine.lineNumber,
                      },
                      setCommentTarget,
                    );
                  }
                }}
                type="button"
              >
                <MessageSquare size={12} />
              </button>
            )}
            selectedLines={getSelectedLineRange(file, commentTarget)}
          />
        )}
      </div>
    </section>
  );
}

function PatchsetRail({
  onSelectComparison,
  snapshot,
}: {
  onSelectComparison(from: number, to: number): void;
  snapshot: ReviewSnapshot;
}) {
  return (
    <section className="patchset-rail">
      <div className="rail-label">
        <GitBranch size={14} />
        <span>Patchsets</span>
        <label>
          From
          <select
            aria-label="Comparison from patchset"
            onChange={(event) =>
              onSelectComparison(
                Number.parseInt(event.target.value, 10),
                snapshot.comparison.toPatchsetNumber,
              )
            }
            value={snapshot.comparison.fromPatchsetNumber}
          >
            {snapshot.patchsets.map((patchset) => (
              <option key={patchset.patchsetNumber} value={patchset.patchsetNumber}>
                PS {patchset.patchsetNumber}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select
            aria-label="Comparison to patchset"
            onChange={(event) =>
              onSelectComparison(
                snapshot.comparison.fromPatchsetNumber,
                Number.parseInt(event.target.value, 10),
              )
            }
            value={snapshot.comparison.toPatchsetNumber}
          >
            {snapshot.patchsets.map((patchset) => (
              <option key={patchset.patchsetNumber} value={patchset.patchsetNumber}>
                PS {patchset.patchsetNumber}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rail-track">
        {snapshot.patchsets.map((patchset) => (
          <Tooltip.Root key={patchset.patchsetNumber}>
            <Tooltip.Trigger
              className={[
                "patchset",
                patchset.forcePush ? "force" : "",
                patchset.patchsetNumber === snapshot.comparison.fromPatchsetNumber ? "from" : "",
                patchset.patchsetNumber === snapshot.comparison.toPatchsetNumber ? "to" : "",
              ].join(" ")}
              onClick={() => {
                const nextFromPatchset = Math.min(
                  snapshot.comparison.fromPatchsetNumber,
                  patchset.patchsetNumber,
                );
                const nextToPatchset = Math.max(
                  snapshot.comparison.fromPatchsetNumber,
                  patchset.patchsetNumber,
                );
                onSelectComparison(nextFromPatchset, nextToPatchset);
              }}
            >
              <span>PS {patchset.patchsetNumber}</span>
              <small>{patchset.headSha.slice(0, 7)}</small>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={6}>
                <Tooltip.Popup className="tooltip">
                  {patchset.eventType}
                  {patchset.forcePush ? " · force-push" : ""}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </div>
    </section>
  );
}

function DiffLineAnnotationPanel({
  actionError,
  annotation,
  draftComment,
  file,
  onClearCommentTarget,
  onCreateThread,
  onDraftCommentChange,
  onReply,
  onResolve,
}: {
  actionError?: string;
  annotation: DiffLineAnnotation<ReviewLineAnnotation>;
  draftComment: string;
  file: ReviewFile;
  onClearCommentTarget(): void;
  onCreateThread(file: ReviewFile, anchor?: ThreadAnchorMode): Promise<void>;
  onDraftCommentChange(value: string): void;
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
}) {
  if (annotation.metadata.kind === "draft") {
    return (
      <section className="inline-composer">
        <div className="comment-target">
          <span>
            Line {annotation.lineNumber} · {annotation.side === "deletions" ? "old" : "new"}
          </span>
          <button onClick={onClearCommentTarget}>Clear</button>
        </div>
        <textarea
          aria-label={`New review comment on ${file.path} line ${annotation.lineNumber}`}
          onChange={(event) => onDraftCommentChange(event.target.value)}
          placeholder="Leave a review comment"
          value={draftComment}
        />
        <div>
          {actionError === undefined ? null : <span className="action-error">{actionError}</span>}
          <button
            className="primary-button"
            disabled={draftComment.trim() === ""}
            onClick={() => void onCreateThread(file)}
          >
            <MessageSquare size={15} />
            Comment
          </button>
        </div>
      </section>
    );
  }

  return <ThreadCard onReply={onReply} onResolve={onResolve} thread={annotation.metadata.thread} />;
}

function ThreadCard({
  onReply,
  onResolve,
  thread,
}: {
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
  thread: ReviewThread;
}) {
  const [replyDraft, setReplyDraft] = useState("");

  return (
    <article className="thread">
      <div className="thread-anchor">
        {thread.anchor.status !== "current" ? (
          <CircleAlert size={14} />
        ) : (
          <MessageSquare size={14} />
        )}
        <span>
          PS {thread.anchor.originalPatchsetNumber} line {thread.anchor.originalLine}
        </span>
        {thread.anchor.status !== "current" ? <b>{thread.anchor.status}</b> : null}
        {thread.status === "resolved" ? <b>resolved</b> : null}
      </div>
      {thread.comments.map((comment) => (
        <div className="comment" key={comment.id}>
          <Avatar avatarUrl={comment.author.avatarUrl} login={comment.author.login} />
          <div>
            <div className="comment-head">
              <strong>{comment.author.login}</strong>
              <span>{formatRelative(comment.createdAt)}</span>
              {comment.githubUrl === undefined ? (
                comment.mirroredToGithub ? (
                  <Github size={13} />
                ) : null
              ) : (
                <a aria-label="Open comment in GitHub" href={comment.githubUrl}>
                  <Github size={13} />
                </a>
              )}
              {comment.newSinceLastVisit ? <b>new</b> : null}
            </div>
            <p>{comment.body}</p>
          </div>
        </div>
      ))}
      {thread.status === "open" ? (
        <div className="thread-actions">
          <input
            aria-label="Reply"
            onChange={(event) => setReplyDraft(event.target.value)}
            placeholder="Reply"
            value={replyDraft}
          />
          <button
            onClick={() =>
              void onReply(thread.id, replyDraft).then(() => {
                setReplyDraft("");
              })
            }
          >
            <Send size={14} />
          </button>
          <button onClick={() => void onResolve(thread.id)}>
            <Check size={14} />
            Resolve
          </button>
        </div>
      ) : null}
    </article>
  );
}

function buildDiffLineAnnotations(
  file: ReviewFile,
  threads: ReviewThread[],
  commentTarget: CommentTarget | undefined,
): DiffLineAnnotation<ReviewLineAnnotation>[] {
  const annotations = threads
    .filter(
      (thread) =>
        thread.anchor.currentPath === file.path || thread.anchor.originalPath === file.path,
    )
    .map(
      (thread): DiffLineAnnotation<ReviewLineAnnotation> => ({
        lineNumber: thread.anchor.currentLine ?? thread.anchor.originalLine,
        metadata: {
          kind: "thread",
          thread,
        },
        side: thread.anchor.side === "LEFT" ? "deletions" : "additions",
      }),
    );

  if (commentTarget?.path === file.path) {
    annotations.push({
      lineNumber: commentTarget.line,
      metadata: {
        kind: "draft",
      },
      side: commentTarget.side === "LEFT" ? "deletions" : "additions",
    });
  }

  return annotations;
}

type CommentTarget = {
  line: number;
  path: string;
  side: "LEFT" | "RIGHT";
  sourceText: string;
};

type ThreadAnchorMode = "file" | "selected-line";

type DiffViewerOptions = {
  backgrounds: boolean;
  diffStyle: "unified" | "split";
  indicators: DiffIndicators;
  lineDiffType: LineDiffTypes;
  lineNumbers: boolean;
  wrapping: boolean;
};

type ReviewLineAnnotation =
  | {
      kind: "draft";
    }
  | {
      kind: "thread";
      thread: ReviewThread;
    };

type TokenHover = {
  end: number;
  lineNumber: number;
  side: "additions" | "deletions";
  start: number;
  text: string;
  x: number;
  y: number;
};

function setCommentTargetFromRange(
  file: ReviewFile,
  range: SelectedLineRange,
  setCommentTarget: Dispatch<SetStateAction<CommentTarget | undefined>>,
): void {
  const side = range.endSide ?? range.side ?? "additions";
  const line = range.end;
  setCommentTarget({
    line,
    path: file.path,
    side: side === "deletions" ? "LEFT" : "RIGHT",
    sourceText: getPatchLineText(file.patch, line, side === "deletions" ? "LEFT" : "RIGHT"),
  });
}

function getSelectedLineRange(
  file: ReviewFile,
  target: CommentTarget | undefined,
): SelectedLineRange | null {
  if (target === undefined || target.path !== file.path) {
    return null;
  }

  const side = target.side === "LEFT" ? "deletions" : "additions";
  return {
    end: target.line,
    endSide: side,
    side,
    start: target.line,
  };
}

function getPatchLineText(
  patch: string | undefined,
  lineNumber: number,
  side: "LEFT" | "RIGHT",
): string {
  if (patch === undefined) {
    return "";
  }

  let leftLineNumber: number | undefined;
  let rightLineNumber: number | undefined;

  for (const rawLine of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk?.[1] !== undefined && hunk[2] !== undefined) {
      leftLineNumber = Number.parseInt(hunk[1], 10);
      rightLineNumber = Number.parseInt(hunk[2], 10);
      continue;
    }

    if (leftLineNumber === undefined || rightLineNumber === undefined) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      if (side === "RIGHT" && rightLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      rightLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      if (side === "LEFT" && leftLineNumber === lineNumber) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      if (
        (side === "LEFT" && leftLineNumber === lineNumber) ||
        (side === "RIGHT" && rightLineNumber === lineNumber)
      ) {
        return rawLine.slice(1);
      }
      leftLineNumber += 1;
      rightLineNumber += 1;
    }
  }

  return "";
}

function StatusPill({ label, tone }: { label: string; tone: "cool" | "hot" | "muted" }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function TokenHoverCard({ hover }: { hover: TokenHover }) {
  return (
    <div
      className="token-hover-card"
      style={{
        left: Math.min(hover.x + 14, window.innerWidth - 260),
        top: hover.y + 14,
      }}
    >
      <strong>{hover.text}</strong>
      <span>
        Line {hover.lineNumber}, {hover.side === "additions" ? "new" : "old"} · chars {hover.start}-
        {hover.end}
      </span>
    </div>
  );
}

function AccountMenu({ avatarUrl, login }: { avatarUrl?: string; login: string }) {
  return (
    <details className="account-menu">
      <summary className="account-button">
        <Avatar avatarUrl={avatarUrl} login={login} />
        <span>{login}</span>
        <ChevronDown size={14} />
      </summary>
      <div className="account-popover">
        <div className="account-heading">
          <span>Signed in as</span>
          <strong>{login}</strong>
        </div>
        <a className="account-menu-item" href="/auth/logout">
          <LogOut size={15} />
          Sign out
        </a>
      </div>
    </details>
  );
}

function Avatar({ avatarUrl, login }: { avatarUrl?: string; login: string }) {
  if (avatarUrl !== undefined && avatarUrl.trim() !== "") {
    return <img alt="" className="avatar" src={avatarUrl} />;
  }

  return <span className="avatar">{login.slice(0, 1).toUpperCase()}</span>;
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

type ClientRequestOptions = {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
};

type ClientResponse = {
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
};

async function requestJson<T>(url: string, options: ClientRequestOptions): Promise<T> {
  const response = await request(url, options);
  if (!response.ok) {
    throw new Error(await readActionError(response));
  }

  return (await response.json()) as T;
}

function request(url: string, options: ClientRequestOptions = {}): Promise<ClientResponse> {
  if (typeof window.fetch === "function") {
    return window.fetch(url, options);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "GET", url);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.addEventListener("load", () => {
      resolve({
        json: async () => (xhr.responseText === "" ? {} : JSON.parse(xhr.responseText)),
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
      });
    });
    xhr.addEventListener("error", () => reject(new Error("request failed")));
    xhr.send(options.body);
  });
}

function readLocalPreference(key: string): string | undefined {
  try {
    return window.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLocalPreference(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    return;
  }
}

function readDiffOptions(): DiffViewerOptions {
  const rawValue = readLocalPreference("clearance.diffOptions");
  if (rawValue === undefined) {
    return defaultDiffOptions;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<DiffViewerOptions>;
    return {
      backgrounds:
        typeof parsed.backgrounds === "boolean"
          ? parsed.backgrounds
          : defaultDiffOptions.backgrounds,
      diffStyle: parsed.diffStyle === "split" ? "split" : defaultDiffOptions.diffStyle,
      indicators: isDiffIndicator(parsed.indicators)
        ? parsed.indicators
        : defaultDiffOptions.indicators,
      lineDiffType: isLineDiffType(parsed.lineDiffType)
        ? parsed.lineDiffType
        : defaultDiffOptions.lineDiffType,
      lineNumbers:
        typeof parsed.lineNumbers === "boolean"
          ? parsed.lineNumbers
          : defaultDiffOptions.lineNumbers,
      wrapping:
        typeof parsed.wrapping === "boolean" ? parsed.wrapping : defaultDiffOptions.wrapping,
    };
  } catch {
    return defaultDiffOptions;
  }
}

function isDiffIndicator(value: unknown): value is DiffIndicators {
  return value === "bars" || value === "classic" || value === "none";
}

function isLineDiffType(value: unknown): value is LineDiffTypes {
  return value === "word-alt" || value === "word" || value === "char" || value === "none";
}

async function readActionError(response: ClientResponse): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function parseReviewRoute(pathname: string): { owner: string; pullNumber: number; repo: string } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "review" && segments[3] === "pull" && segments[4] !== undefined) {
    return {
      owner: decodeURIComponent(segments[1] ?? "acme"),
      pullNumber: Number.parseInt(segments[4], 10) || 1,
      repo: decodeURIComponent(segments[2] ?? "repo"),
    };
  }

  return { owner: "acme", pullNumber: 1, repo: "repo" };
}

function buildReviewApiUrl(
  route: { owner: string; pullNumber: number; repo: string },
  comparison: { from?: number; to?: number },
): string {
  const params = new URLSearchParams();
  if (comparison.from !== undefined) {
    params.set("from", String(comparison.from));
  }
  if (comparison.to !== undefined) {
    params.set("to", String(comparison.to));
  }

  const query = params.toString();
  return `/api/review/${route.owner}/${route.repo}/pull/${route.pullNumber}${
    query === "" ? "" : `?${query}`
  }`;
}

type MeResponse = {
  authenticated: boolean;
  csrfToken?: string;
  loginUrl?: string;
  viewer?: {
    avatarUrl?: string;
    login: string;
  };
};

type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

createRoot(document.querySelector("#root") as HTMLElement).render(<App />);
