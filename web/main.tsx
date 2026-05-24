import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  GitBranch,
  Github,
  LogIn,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";

import type { ReviewFile, ReviewSnapshot } from "../src/review/types";
// oxlint-disable-next-line import/no-unassigned-import
import "./styles.css";

const defaultViewerLogin = readLocalPreference("clearance.viewer") ?? "tim";

function App() {
  const route = parseReviewRoute(window.location.pathname);
  const [viewerLogin, setViewerLogin] = useState(defaultViewerLogin);
  const [me, setMe] = useState<MeResponse | undefined>();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [draftComment, setDraftComment] = useState("");
  const [commentTarget, setCommentTarget] = useState<CommentTarget | undefined>();
  const [passTarget, setPassTarget] = useState("");
  const [actionError, setActionError] = useState<string | undefined>();
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

  const selectedFile =
    snapshot.files.find((file) => file.path === selectedPath) ?? snapshot.files[0];
  const hasPatchsetControls = snapshot.patchsets.length > 1;

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

  async function notMyTurn(): Promise<void> {
    setActionError(undefined);
    const response = await postJson("/attention/not-my-turn");
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    setSnapshot((current) =>
      current === undefined
        ? current
        : {
            ...current,
            attention: {
              isViewerTurn: false,
              members: current.attention.members.filter((member) => member.login !== viewerLogin),
            },
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

  async function createThread(): Promise<void> {
    const currentSnapshot = snapshot;
    if (currentSnapshot === undefined || selectedFile === undefined || draftComment.trim() === "") {
      return;
    }

    setActionError(undefined);
    const response = await postJson("/threads", {
      body: draftComment.trim(),
      commitSha: currentSnapshot.pullRequest.headSha,
      filePath: selectedFile.path,
      line: commentTarget?.path === selectedFile.path ? commentTarget.line : undefined,
      patchsetNumber: currentSnapshot.comparison.toPatchsetNumber,
      side: commentTarget?.path === selectedFile.path ? commentTarget.side : undefined,
      sourceText:
        commentTarget?.path === selectedFile.path
          ? commentTarget.sourceText
          : selectedFile.patch?.slice(0, 600),
    });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    setDraftComment("");
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

    await refreshReview();
  }

  async function approveReview(): Promise<void> {
    setActionError(undefined);
    const response = await postJson("/reviews/approve", {
      body: "Reviewed in Clearance.",
    });
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    await refreshReview();
  }

  return (
    <Tooltip.Provider>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <ShieldCheck size={20} />
            <span>Clearance Review</span>
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
            {me?.authenticated ? (
              <a className="auth-pill" href="/auth/logout">
                <Avatar login={me.viewer?.login ?? viewerLogin} />
                <span>{me.viewer?.login ?? viewerLogin}</span>
              </a>
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
            <label className={me?.authenticated ? "viewer locked" : "viewer"}>
              <span>@</span>
              <input
                aria-label="Viewer"
                disabled={me?.authenticated}
                onChange={(event) => setViewerLogin(event.target.value)}
                value={viewerLogin}
              />
            </label>
            <IconLink href={snapshot.pullRequest.htmlUrl} label="Open on GitHub">
              <Github size={17} />
            </IconLink>
          </div>
        </header>

        <section className="statebar">
          <StatusPill
            label={snapshot.attention.isViewerTurn ? "Your turn" : "Not your turn"}
            tone={snapshot.attention.isViewerTurn ? "hot" : "muted"}
          />
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
          <div className="state-actions">
            <button onClick={() => void notMyTurn()}>
              <Eye size={15} />
              Not my turn
            </button>
            <button onClick={() => void approveReview()}>
              <Check size={15} />
              Approve
            </button>
            <div className="state-pass">
              <input
                aria-label="Pass attention to"
                onChange={(event) => setPassTarget(event.target.value)}
                placeholder="github-user"
                value={passTarget}
              />
              <button onClick={() => void passAttention()}>
                <Send size={15} />
                Pass
              </button>
            </div>
          </div>
        </section>

        <div className="review-grid">
          <aside className="file-pane">
            <div className="pane-heading">
              <span>Files</span>
              <span>{snapshot.files.length}</span>
            </div>
            <ReviewFileList
              files={snapshot.files}
              onSelect={setSelectedPath}
              selectedPath={selectedFile?.path}
            />
            <div className="file-legend">
              <span>
                <i className="dot current" /> current
              </span>
              <span>
                <i className="dot stale" /> stale
              </span>
              <span>
                <i className="dot unreviewed" /> open
              </span>
            </div>
          </aside>

          <main className="diff-pane">
            {hasPatchsetControls ? (
              <PatchsetRail onSelectComparison={selectComparison} snapshot={snapshot} />
            ) : null}
            {selectedFile === undefined ? (
              <div className="empty-state">No changed files</div>
            ) : (
              <>
                <div className="file-header">
                  <div>
                    <strong>{selectedFile.path}</strong>
                    <span>
                      {selectedFile.status} · +{selectedFile.additions} -{selectedFile.deletions}
                      {commentTarget?.path === selectedFile.path
                        ? ` · commenting on line ${commentTarget.line}`
                        : ""}
                    </span>
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => void markReviewed(selectedFile)}
                  >
                    <Check size={15} />
                    Mark reviewed
                  </button>
                </div>
                <div className="diff-scroll">
                  {selectedFile.patch === undefined ? (
                    <pre className="no-patch">Patch content has not been indexed yet.</pre>
                  ) : (
                    <PatchDiff
                      disableWorkerPool
                      options={{
                        diffIndicators: "bars",
                        diffStyle: "unified",
                        enableGutterUtility: true,
                        hunkSeparators: "line-info-basic",
                        lineHoverHighlight: "both",
                        overflow: "scroll",
                        theme: {
                          dark: "pierre-dark",
                          light: "pierre-light",
                        },
                      }}
                      patch={selectedFile.patch}
                      renderGutterUtility={(getHoveredLine) => (
                        <button
                          aria-label="Comment on line"
                          className="gutter-comment"
                          onClick={() => {
                            const hoveredLine = getHoveredLine();
                            if (hoveredLine !== undefined) {
                              setCommentTargetFromRange(
                                selectedFile,
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
                      selectedLines={getSelectedLineRange(selectedFile, commentTarget)}
                    />
                  )}
                  <section className="composer">
                    {commentTarget?.path === selectedFile.path ? (
                      <div className="comment-target">
                        <span>
                          Line {commentTarget.line} ·{" "}
                          {commentTarget.side === "LEFT" ? "old" : "new"}
                        </span>
                        <button onClick={() => setCommentTarget(undefined)}>Clear</button>
                      </div>
                    ) : null}
                    <textarea
                      aria-label="New review comment"
                      onChange={(event) => setDraftComment(event.target.value)}
                      placeholder="Leave a durable review thread on this file"
                      value={draftComment}
                    />
                    <div>
                      {actionError === undefined ? null : (
                        <span className="action-error">{actionError}</span>
                      )}
                      <button
                        className="primary-button"
                        disabled={draftComment.trim() === ""}
                        onClick={() => void createThread()}
                      >
                        <MessageSquare size={15} />
                        Comment
                      </button>
                    </div>
                  </section>
                  <ThreadList
                    onReply={replyToThread}
                    onResolve={resolveThread}
                    selectedPath={selectedFile.path}
                    snapshot={snapshot}
                  />
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function ReviewFileList(props: {
  files: ReviewFile[];
  onSelect(path: string): void;
  selectedPath?: string;
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
          files.map((file) => (
            <button
              className={[
                "file-row",
                file.path === props.selectedPath ? "selected" : "",
                file.markState,
              ].join(" ")}
              key={file.path}
              onClick={() => props.onSelect(file.path)}
              type="button"
            >
              <span className="file-row-path">{file.path}</span>
              <span className="file-row-meta">
                {file.status} · +{file.additions} -{file.deletions}
              </span>
            </button>
          ))
        )}
      </div>
    </>
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

function ThreadList({
  onReply,
  onResolve,
  selectedPath,
  snapshot,
}: {
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
  selectedPath: string;
  snapshot: ReviewSnapshot;
}) {
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const threads = snapshot.threads.filter(
    (thread) =>
      thread.anchor.currentPath === selectedPath || thread.anchor.originalPath === selectedPath,
  );
  if (threads.length === 0) {
    return null;
  }

  return (
    <section className="threads">
      {threads.map((thread) => (
        <article className="thread" key={thread.id}>
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
              <Avatar login={comment.author.login} />
              <div>
                <div className="comment-head">
                  <strong>{comment.author.login}</strong>
                  <span>{formatRelative(comment.createdAt)}</span>
                  {comment.mirroredToGithub ? <Github size={13} /> : null}
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
                onChange={(event) =>
                  setReplyDrafts((current) => ({
                    ...current,
                    [thread.id]: event.target.value,
                  }))
                }
                placeholder="Reply"
                value={replyDrafts[thread.id] ?? ""}
              />
              <button
                onClick={() => {
                  const body = replyDrafts[thread.id] ?? "";
                  void onReply(thread.id, body).then(() =>
                    setReplyDrafts((current) => ({ ...current, [thread.id]: "" })),
                  );
                }}
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
      ))}
    </section>
  );
}

type CommentTarget = {
  line: number;
  path: string;
  side: "LEFT" | "RIGHT";
  sourceText: string;
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

function IconLink({
  children,
  href,
  label,
}: {
  children: React.ReactNode;
  href: string;
  label: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className="icon-button" render={<a href={href} />}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Avatar({ login }: { login: string }) {
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

createRoot(document.querySelector("#root") as HTMLElement).render(<App />);
