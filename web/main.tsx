import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import type {
  DiffIndicators,
  DiffLineAnnotation,
  LineDiffTypes,
  SelectedLineRange,
} from "@pierre/diffs";
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
  Monitor,
  Moon,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sun,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReviewFile, ReviewSnapshot, ReviewThread } from "../src/review/types";
// oxlint-disable-next-line import/no-unassigned-import
import "./styles.css";

const defaultViewerLogin = readLocalPreference("clearance.viewer") ?? "tim";
const defaultColorMode: ColorMode = "system";
const defaultDiffOptions: DiffViewerOptions = {
  backgrounds: true,
  diffStyle: "unified",
  indicators: "bars",
  lineDiffType: "word-alt",
  lineNumbers: true,
  wrapping: false,
};
const keyBindingStyleOptions = [
  { label: "VS Code", value: "vscode" },
  { label: "GitHub", value: "github" },
] satisfies { label: string; value: KeyboardBindingStyle }[];

function App() {
  const route = parseReviewRoute(window.location.pathname);
  const [viewerLogin, setViewerLogin] = useState(defaultViewerLogin);
  const [me, setMe] = useState<MeResponse | undefined>();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [draftComments, setDraftComments] = useState<Record<string, string>>({});
  const [reviewBody, setReviewBody] = useState("");
  const [commentTarget, setCommentTarget] = useState<CommentTarget | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | undefined>();
  const [passTarget, setPassTarget] = useState("");
  const [actionError, setActionError] = useState<string | undefined>();
  const [colorMode, setColorMode] = useState(readColorMode);
  const [diffOptions, setDiffOptions] = useState(readDiffOptions);
  const [keyBindingStyle, setKeyBindingStyle] =
    useState<KeyboardBindingStyle>(readKeyboardBindingStyle);
  const [tokenHover, setTokenHover] = useState<TokenHover | undefined>();
  const [comparisonSelection, setComparisonSelection] = useState<{
    from?: number;
    to?: number;
  }>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const fileFilterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    writeLocalPreference("clearance.viewer", viewerLogin);
  }, [viewerLogin]);

  useEffect(() => {
    writeLocalPreference("clearance.diffOptions", JSON.stringify(diffOptions));
  }, [diffOptions]);

  useEffect(() => {
    writeLocalPreference("clearance.keyBindingStyle", keyBindingStyle);
  }, [keyBindingStyle]);

  useEffect(() => {
    applyColorMode(colorMode);
    writeLocalPreference("clearance.colorMode", colorMode);

    if (colorMode !== "system" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemColorModeChange = () => applyColorMode("system");
    mediaQuery.addEventListener("change", handleSystemColorModeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemColorModeChange);
  }, [colorMode]);

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

  const activeSnapshot = snapshot;
  const hasPatchsetControls = snapshot.patchsets.length > 1;
  const canShowTurnIndicator =
    me?.authenticated === true && snapshot.capabilities.mode === "indexed";
  const canUseReviewerActions = canShowTurnIndicator && snapshot.attention.isViewerTurn;
  const canManageAttention = me?.authenticated === true && snapshot.capabilities.mode === "indexed";
  const canMarkReviewed = me?.authenticated === true && snapshot.capabilities.mode === "indexed";
  const threadStatsByPath = buildFileThreadStatsByPath(snapshot.threads);
  const reviewModel = buildReviewModel(snapshot);

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
    setSelectedThreadId(undefined);
    setSelectedIssueKey(undefined);
    setCommentTarget(undefined);
  }

  function jumpToFile(path: string): void {
    setSelectedPath(path);
    setSelectedThreadId(undefined);
    setSelectedIssueKey(undefined);
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

  async function markNotMyTurn(): Promise<void> {
    setActionError(undefined);
    const response = await postJson("/attention/not-my-turn");
    if (!response.ok) {
      setActionError(await readActionError(response));
      return;
    }

    await refreshReview();
  }

  function navigateToTarget(target: ReviewNavigationTarget | undefined): void {
    if (target === undefined) {
      return;
    }

    setSelectedIssueKey(reviewTargetKey(target));
    if (target.type === "file") {
      jumpToFile(target.path);
      setSelectedIssueKey(reviewTargetKey(target));
      return;
    }

    setSelectedPath(target.path);
    setSelectedThreadId(target.threadId);
    window.requestAnimationFrame(() => {
      document.getElementById(threadSectionId(target.threadId))?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }

  function navigateFile(direction: 1 | -1): void {
    if (activeSnapshot.files.length === 0) {
      return;
    }

    const currentIndex = Math.max(
      0,
      selectedPath === undefined
        ? 0
        : activeSnapshot.files.findIndex((file) => file.path === selectedPath),
    );
    const nextIndex = wrapIndex(currentIndex + direction, activeSnapshot.files.length);
    const nextFile = activeSnapshot.files[nextIndex];
    if (nextFile !== undefined) {
      jumpToFile(nextFile.path);
    }
  }

  function navigateReviewIssue(direction: 1 | -1): void {
    const targets = buildReviewIssueTargets(activeSnapshot);
    if (targets.length === 0) {
      return;
    }

    const currentIndex = getCurrentReviewTargetIndex(targets, selectedIssueKey, selectedThreadId);
    const nextIndex = wrapIndex(currentIndex + direction, targets.length);
    navigateToTarget(targets[nextIndex]);
  }

  function markCurrentFileReviewed(): void {
    const file =
      activeSnapshot.files.find((entry) => entry.path === selectedPath) ?? activeSnapshot.files[0];
    if (file !== undefined && canMarkReviewed) {
      void markReviewed(file);
    }
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
    <TooltipProvider>
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
            <ColorModeControl mode={colorMode} onChange={setColorMode} />
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
            <AttentionMenu
              actionTarget={reviewModel.firstActionTarget}
              canManage={canManageAttention}
              error={actionError}
              onNavigate={navigateToTarget}
              onNotMyTurn={markNotMyTurn}
              onPass={passAttention}
              onPassTargetChange={setPassTarget}
              passTarget={passTarget}
              snapshot={snapshot}
              showTurnState={canShowTurnIndicator}
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
                    <Button
                      className="justify-start"
                      onClick={() => void submitReview("COMMENT")}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <MessageSquare size={15} />
                      Comment
                    </Button>
                    <Button
                      className="justify-start"
                      onClick={() => void submitReview("APPROVE")}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      <Check size={15} />
                      Approve
                    </Button>
                    <Button
                      className="justify-start"
                      onClick={() => void submitReview("REQUEST_CHANGES")}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      <CircleAlert size={15} />
                      Request changes
                    </Button>
                  </div>
                </div>
              </details>
            </div>
          ) : null}
        </section>

        <ReviewOverview model={reviewModel} onNavigate={navigateToTarget} />

        <div className="review-grid">
          <aside className="file-pane">
            <ReviewFileList
              filterInputRef={fileFilterRef}
              files={snapshot.files}
              onSelect={jumpToFile}
              selectedPath={selectedPath}
              threadStatsByPath={threadStatsByPath}
            />
          </aside>

          <main className="diff-pane">
            <DiffToolbar
              fileCount={snapshot.files.length}
              keyBindingStyle={keyBindingStyle}
              onChange={updateDiffOption}
              onKeyBindingStyleChange={setKeyBindingStyle}
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
                  colorMode={colorMode}
                  commentTarget={commentTarget}
                  diffOptions={diffOptions}
                  draftComment={draftComments[file.path] ?? ""}
                  file={file}
                  key={file.path}
                  keyBindingStyle={keyBindingStyle}
                  onClearCommentTarget={() => setCommentTarget(undefined)}
                  onCreateThread={createThread}
                  onDraftCommentChange={(value) => updateDraftComment(file.path, value)}
                  onMarkReviewed={markReviewed}
                  onReply={replyToThread}
                  onResolve={resolveThread}
                  onSelectFile={setSelectedPath}
                  onSelectThread={setSelectedThreadId}
                  selected={file.path === selectedPath}
                  selectedThreadId={selectedThreadId}
                  setTokenHover={setTokenHover}
                  setCommentTarget={setCommentTarget}
                  snapshot={snapshot}
                />
              ))
            )}
          </main>
        </div>
        <ReviewKeyboardController
          canMarkReviewed={canMarkReviewed}
          fileFilterRef={fileFilterRef}
          keyBindingStyle={keyBindingStyle}
          onClearCommentTarget={() => setCommentTarget(undefined)}
          onMarkCurrentFileReviewed={markCurrentFileReviewed}
          onNavigateFile={navigateFile}
          onNavigateReviewIssue={navigateReviewIssue}
        />
        {tokenHover === undefined ? null : <TokenHoverCard hover={tokenHover} />}
      </div>
    </TooltipProvider>
  );
}

function ReviewFileList(props: {
  filterInputRef: RefObject<HTMLInputElement | null>;
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
          ref={props.filterInputRef}
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
  keyBindingStyle,
  onChange,
  onKeyBindingStyleChange,
  options,
}: {
  fileCount: number;
  keyBindingStyle: KeyboardBindingStyle;
  onChange<T extends keyof DiffViewerOptions>(key: T, value: DiffViewerOptions[T]): void;
  onKeyBindingStyleChange(value: KeyboardBindingStyle): void;
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
          <fieldset>
            <legend>Key bindings</legend>
            <SegmentedControl
              onChange={(value) => onKeyBindingStyleChange(value as KeyboardBindingStyle)}
              options={keyBindingStyleOptions}
              value={keyBindingStyle}
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

function AttentionMenu({
  actionTarget,
  canManage,
  error,
  onNavigate,
  onNotMyTurn,
  onPass,
  onPassTargetChange,
  passTarget,
  showTurnState,
  snapshot,
}: {
  actionTarget?: ReviewNavigationTarget;
  canManage: boolean;
  error?: string;
  onNavigate(target: ReviewNavigationTarget | undefined): void;
  onNotMyTurn(): Promise<void>;
  onPass(): Promise<void>;
  onPassTargetChange(value: string): void;
  passTarget: string;
  showTurnState: boolean;
  snapshot: ReviewSnapshot;
}) {
  const members = snapshot.attention.members;
  const isViewerTurn = showTurnState && snapshot.attention.isViewerTurn;
  const isStale = members.some((member) => isOlderThanHours(member.addedAt, 24));

  return (
    <details className="attention-menu">
      <summary
        className={["attention-summary", isViewerTurn ? "active" : "", isStale ? "stale" : ""].join(
          " ",
        )}
      >
        <i />
        <span>{getAttentionSummary(snapshot, showTurnState)}</span>
        <ChevronDown size={14} />
      </summary>
      <div className="attention-popover">
        <div className="attention-heading">
          <strong>{isViewerTurn ? "Your turn" : "Attention"}</strong>
          <span>{getAttentionDetail(snapshot, showTurnState)}</span>
        </div>
        <div className="attention-members">
          {members.length === 0 ? (
            <span className="attention-empty">No active attention members</span>
          ) : (
            members.map((member) => (
              <div className="attention-member" key={member.login}>
                <Avatar login={member.login} />
                <div>
                  <strong>{member.login}</strong>
                  <span>
                    {member.reason} · {formatRelative(member.addedAt)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="attention-actions">
          <button
            disabled={actionTarget === undefined}
            onClick={() => onNavigate(actionTarget)}
            type="button"
          >
            <CircleAlert size={14} />
            Open next item
          </button>
          <button
            disabled={!canManage || !snapshot.attention.isViewerTurn}
            onClick={() => void onNotMyTurn()}
            type="button"
          >
            <Check size={14} />
            Not my turn
          </button>
        </div>
        <div className="attention-pass">
          <input
            aria-label="Pass attention to"
            disabled={!canManage}
            onChange={(event) => onPassTargetChange(event.target.value)}
            placeholder="Reviewer login"
            value={passTarget}
          />
          <button disabled={!canManage || passTarget.trim() === ""} onClick={() => void onPass()}>
            <Send size={14} />
            Pass
          </button>
        </div>
        {error === undefined ? null : <span className="action-error">{error}</span>}
      </div>
    </details>
  );
}

function ReviewOverview({
  model,
  onNavigate,
}: {
  model: ReviewModel;
  onNavigate(target: ReviewNavigationTarget | undefined): void;
}) {
  return (
    <section className="review-overview">
      <details className={`readiness-panel ${model.readiness.tone}`}>
        <summary className="readiness-summary">
          <span className="readiness-dot" />
          <strong>{model.readiness.label}</strong>
          <span>{model.readiness.detail}</span>
          <ChevronDown size={14} />
        </summary>
        <div className="readiness-details">
          <div>
            <h2>Needs Attention</h2>
            {model.readiness.blockers.length === 0 ? (
              <p>No blocking review items are currently known.</p>
            ) : (
              model.readiness.blockers.map((item) => (
                <button
                  disabled={item.target === undefined}
                  key={item.id}
                  onClick={() => onNavigate(item.target)}
                  type="button"
                >
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </button>
              ))
            )}
          </div>
          <div>
            <h2>Satisfied</h2>
            {model.readiness.satisfied.length === 0 ? (
              <p>No satisfied review items yet.</p>
            ) : (
              model.readiness.satisfied.map((item) => (
                <span className="readiness-satisfied" key={item.id}>
                  <Check size={13} />
                  {item.label}
                </span>
              ))
            )}
          </div>
        </div>
      </details>
      <div className="check-chip-row">
        {model.chips.map((chip) =>
          chip.target === undefined ? (
            <span className={`check-chip ${chip.tone}`} key={chip.id}>
              <i />
              <strong>{chip.label}</strong>
              <span>{chip.value}</span>
            </span>
          ) : (
            <button
              className={`check-chip ${chip.tone}`}
              key={chip.id}
              onClick={() => onNavigate(chip.target)}
              type="button"
            >
              <i />
              <strong>{chip.label}</strong>
              <span>{chip.value}</span>
            </button>
          ),
        )}
      </div>
    </section>
  );
}

function ReviewKeyboardController({
  canMarkReviewed,
  fileFilterRef,
  keyBindingStyle,
  onClearCommentTarget,
  onMarkCurrentFileReviewed,
  onNavigateFile,
  onNavigateReviewIssue,
}: {
  canMarkReviewed: boolean;
  fileFilterRef: RefObject<HTMLInputElement | null>;
  keyBindingStyle: KeyboardBindingStyle;
  onClearCommentTarget(): void;
  onMarkCurrentFileReviewed(): void;
  onNavigateFile(direction: 1 | -1): void;
  onNavigateReviewIssue(direction: 1 | -1): void;
}) {
  const chordTimeoutRef = useRef<number | undefined>(undefined);
  const chordActiveRef = useRef(false);

  useEffect(() => {
    function clearChord(): void {
      chordActiveRef.current = false;
      if (chordTimeoutRef.current !== undefined) {
        window.clearTimeout(chordTimeoutRef.current);
        chordTimeoutRef.current = undefined;
      }
    }

    function startChord(): void {
      clearChord();
      chordActiveRef.current = true;
      chordTimeoutRef.current = window.setTimeout(clearChord, 1400);
    }

    function focusFileFilter(event: globalThis.KeyboardEvent): void {
      event.preventDefault();
      fileFilterRef.current?.focus();
      fileFilterRef.current?.select();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      const key = event.key.toLowerCase();
      const primaryModifier = event.metaKey || event.ctrlKey;

      if (chordActiveRef.current) {
        if (key === "v" && canMarkReviewed) {
          event.preventDefault();
          onMarkCurrentFileReviewed();
        }
        clearChord();
        return;
      }

      if (isEditableTarget(event.target)) {
        if (event.key === "Escape") {
          onClearCommentTarget();
        }
        if (keyBindingStyle === "vscode" && primaryModifier && !event.shiftKey && key === "p") {
          focusFileFilter(event);
        }
        return;
      }

      if (keyBindingStyle === "vscode") {
        if (primaryModifier && !event.shiftKey && key === "p") {
          focusFileFilter(event);
          return;
        }

        if (primaryModifier && !event.shiftKey && key === "k") {
          event.preventDefault();
          startChord();
          return;
        }

        if (event.key === "F8") {
          event.preventDefault();
          onNavigateReviewIssue(event.shiftKey ? -1 : 1);
          return;
        }

        if (primaryModifier && event.key === "PageDown") {
          event.preventDefault();
          onNavigateFile(1);
          return;
        }

        if (primaryModifier && event.key === "PageUp") {
          event.preventDefault();
          onNavigateFile(-1);
          return;
        }
      } else if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        if (key === "t") {
          focusFileFilter(event);
          return;
        }

        if (key === "j") {
          event.preventDefault();
          onNavigateReviewIssue(1);
          return;
        }

        if (key === "k") {
          event.preventDefault();
          onNavigateReviewIssue(-1);
          return;
        }

        if (event.key === "]") {
          event.preventDefault();
          onNavigateFile(1);
          return;
        }

        if (event.key === "[") {
          event.preventDefault();
          onNavigateFile(-1);
          return;
        }

        if (key === "v" && canMarkReviewed) {
          event.preventDefault();
          onMarkCurrentFileReviewed();
          return;
        }
      }

      if (event.key === "Escape") {
        onClearCommentTarget();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearChord();
    };
  }, [
    canMarkReviewed,
    fileFilterRef,
    keyBindingStyle,
    onClearCommentTarget,
    onMarkCurrentFileReviewed,
    onNavigateFile,
    onNavigateReviewIssue,
  ]);

  return null;
}

function ColorModeControl({
  mode,
  onChange,
}: {
  mode: ColorMode;
  onChange(mode: ColorMode): void;
}) {
  const options = [
    { Icon: Monitor, label: "System", value: "system" },
    { Icon: Sun, label: "Light", value: "light" },
    { Icon: Moon, label: "Dark", value: "dark" },
  ] as const;

  return (
    <div aria-label="Color mode" className="color-mode-control" role="radiogroup">
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            aria-checked={option.value === mode}
            aria-label={`${option.label} color mode`}
            className={option.value === mode ? "active" : ""}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            <option.Icon size={14} />
            <span className="sr-only">{option.label}</span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
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

function threadSectionId(threadId: string): string {
  return `thread-${encodeURIComponent(threadId)}`;
}

function buildReviewModel(snapshot: ReviewSnapshot): ReviewModel {
  const openThreads = snapshot.threads.filter((thread) => thread.status === "open");
  const newThreads = snapshot.threads.filter((thread) =>
    thread.comments.some((comment) => comment.newSinceLastVisit),
  );
  const pendingRequirements = snapshot.reviewState.requirements.filter(
    (requirement) => requirement.status !== "approved",
  );
  const approvedRequirements = snapshot.reviewState.requirements.filter(
    (requirement) => requirement.status === "approved",
  );
  const unreviewedFiles = snapshot.files.filter((file) => file.markState === "unreviewed");
  const staleFiles = snapshot.files.filter((file) => file.markState === "stale");
  const viewedFiles = snapshot.files.filter((file) => file.markState === "current");
  const firstOpenThreadTarget = openThreads.map(createThreadTarget).find(isDefined);
  const firstNewThreadTarget = newThreads.map(createThreadTarget).find(isDefined);
  const firstUnreviewedFile = [...staleFiles, ...unreviewedFiles][0];
  const firstRequirementFile = pendingRequirements
    .flatMap((requirement) => requirement.relevantFiles)
    .find((path) => snapshot.files.some((file) => file.path === path));
  const firstFileTarget =
    firstUnreviewedFile === undefined ? undefined : createFileTarget(firstUnreviewedFile.path);
  const firstRequirementTarget =
    firstRequirementFile === undefined ? undefined : createFileTarget(firstRequirementFile);
  const warnings = snapshot.reviewState.warnings;
  const limitations = snapshot.capabilities.limitations;
  const firstActionTarget =
    firstNewThreadTarget ?? firstOpenThreadTarget ?? firstFileTarget ?? firstRequirementTarget;
  const blockers: ReviewReadinessItem[] = [];
  const satisfied: ReviewReadinessItem[] = [];

  if (snapshot.capabilities.mode === "public") {
    blockers.push({
      detail: "Install or index the repository to enable durable review state.",
      id: "mode-public",
      label: "Public preview has limited review state",
    });
  }

  if (pendingRequirements.length > 0) {
    blockers.push({
      detail: pendingRequirements.map((requirement) => requirement.label).join(", "),
      id: "requirements-pending",
      label: `${pendingRequirements.length} ${plural(pendingRequirements.length, "requirement")} pending`,
      target: firstRequirementTarget,
    });
  }

  if (openThreads.length > 0) {
    blockers.push({
      detail: "Resolve or reply to open review conversations.",
      id: "threads-open",
      label: `${openThreads.length} unresolved ${plural(openThreads.length, "thread")}`,
      target: firstOpenThreadTarget,
    });
  }

  if (staleFiles.length + unreviewedFiles.length > 0 && snapshot.capabilities.mode === "indexed") {
    blockers.push({
      detail: `${viewedFiles.length}/${snapshot.files.length} files are marked viewed.`,
      id: "files-unreviewed",
      label: `${staleFiles.length + unreviewedFiles.length} ${plural(
        staleFiles.length + unreviewedFiles.length,
        "file",
      )} need review`,
      target: firstFileTarget,
    });
  }

  if (warnings.length > 0) {
    blockers.push({
      detail: warnings.slice(0, 2).join(", "),
      id: "warnings",
      label: `${warnings.length} Clearance ${plural(warnings.length, "warning")}`,
    });
  }

  if (approvedRequirements.length > 0) {
    satisfied.push({
      detail: approvedRequirements.map((requirement) => requirement.label).join(", "),
      id: "requirements-approved",
      label: `${approvedRequirements.length} ${plural(approvedRequirements.length, "requirement")} satisfied`,
    });
  }

  if (openThreads.length === 0) {
    satisfied.push({
      detail: "No unresolved review conversations are known.",
      id: "threads-clear",
      label: "Threads clear",
    });
  }

  if (snapshot.files.length > 0 && viewedFiles.length === snapshot.files.length) {
    satisfied.push({
      detail: "Every displayed file is marked viewed.",
      id: "files-viewed",
      label: "Files viewed",
    });
  }

  const readiness = buildReadiness({
    blockers,
    openThreads,
    pendingRequirements,
    snapshot,
    staleFiles,
    unreviewedFiles,
  });

  return {
    chips: [
      {
        id: "clearance-review",
        label: "clearance/review",
        tone: readiness.tone,
        value: readiness.label,
        target: firstActionTarget,
      },
      {
        id: "clearance-config",
        label: "clearance/config",
        tone: warnings.length === 0 ? "success" : "warning",
        value:
          warnings.length === 0
            ? "valid"
            : `${warnings.length} ${plural(warnings.length, "warning")}`,
      },
      {
        id: "threads",
        label: "threads",
        tone: openThreads.length === 0 ? "success" : "warning",
        value: openThreads.length === 0 ? "clear" : `${openThreads.length} open`,
        target: firstOpenThreadTarget,
      },
      {
        id: "files",
        label: "files",
        tone:
          snapshot.capabilities.mode === "public"
            ? "info"
            : staleFiles.length + unreviewedFiles.length === 0
              ? "success"
              : "warning",
        value:
          snapshot.capabilities.mode === "public"
            ? `${snapshot.files.length} files`
            : `${viewedFiles.length}/${snapshot.files.length} viewed`,
        target: firstFileTarget,
      },
      {
        id: "mode",
        label: "mode",
        tone: snapshot.capabilities.mode === "indexed" ? "success" : "info",
        value:
          limitations.length === 0
            ? snapshot.capabilities.mode
            : `${snapshot.capabilities.mode}, ${limitations.length} ${plural(limitations.length, "limit")}`,
      },
      ...(snapshot.activity.newCommentCount === 0
        ? []
        : [
            {
              id: "activity",
              label: "activity",
              tone: "warning" as const,
              value: `${snapshot.activity.newCommentCount} new`,
              target: firstNewThreadTarget,
            },
          ]),
    ],
    firstActionTarget,
    readiness: {
      ...readiness,
      blockers,
      satisfied,
    },
  };
}

function buildReadiness(input: {
  blockers: ReviewReadinessItem[];
  openThreads: ReviewThread[];
  pendingRequirements: ReviewSnapshot["reviewState"]["requirements"];
  snapshot: ReviewSnapshot;
  staleFiles: ReviewFile[];
  unreviewedFiles: ReviewFile[];
}): Omit<ReviewReadiness, "blockers" | "satisfied"> {
  if (input.snapshot.capabilities.mode === "public") {
    return {
      detail: "Indexed requirements, viewed files, and attention writes are unavailable.",
      label: "Public preview",
      state: "limited",
      tone: "info",
    };
  }

  if (input.snapshot.reviewState.override !== undefined) {
    return {
      detail: `Override by ${input.snapshot.reviewState.override.actor}`,
      label: "Ready by override",
      state: "ready",
      tone: "success",
    };
  }

  if (input.pendingRequirements.length > 0) {
    return {
      detail: `${input.pendingRequirements.length} ${plural(
        input.pendingRequirements.length,
        "owner requirement",
      )} still pending.`,
      label: "Needs owner review",
      state: "waiting-on-review",
      tone: "warning",
    };
  }

  if (input.openThreads.length > 0) {
    const waitingOnAuthor = input.snapshot.attention.members.some(
      (member) => member.login === input.snapshot.pullRequest.author,
    );
    return {
      detail: `${input.openThreads.length} unresolved ${plural(input.openThreads.length, "thread")}.`,
      label: waitingOnAuthor ? "Needs author" : "Unresolved threads",
      state: waitingOnAuthor ? "waiting-on-author" : "blocked",
      tone: "warning",
    };
  }

  if (input.staleFiles.length + input.unreviewedFiles.length > 0) {
    return {
      detail: `${input.staleFiles.length + input.unreviewedFiles.length} ${plural(
        input.staleFiles.length + input.unreviewedFiles.length,
        "file",
      )} need review marks.`,
      label: "Review in progress",
      state: "waiting-on-review",
      tone: "warning",
    };
  }

  if (input.blockers.length > 0) {
    return {
      detail: "Review metadata has warnings to inspect.",
      label: "Needs attention",
      state: "blocked",
      tone: "warning",
    };
  }

  return {
    detail: "Requirements, threads, and file marks are clear.",
    label: "Ready",
    state: "ready",
    tone: "success",
  };
}

function ReviewFileSection({
  actionError,
  canMarkReviewed,
  colorMode,
  commentTarget,
  diffOptions,
  draftComment,
  file,
  keyBindingStyle,
  onClearCommentTarget,
  onCreateThread,
  onDraftCommentChange,
  onMarkReviewed,
  onReply,
  onResolve,
  onSelectFile,
  onSelectThread,
  selected,
  selectedThreadId,
  setTokenHover,
  setCommentTarget,
  snapshot,
}: {
  actionError?: string;
  canMarkReviewed: boolean;
  colorMode: ColorMode;
  commentTarget?: CommentTarget;
  diffOptions: DiffViewerOptions;
  draftComment: string;
  file: ReviewFile;
  keyBindingStyle: KeyboardBindingStyle;
  onClearCommentTarget(): void;
  onCreateThread(file: ReviewFile, anchor?: ThreadAnchorMode): Promise<void>;
  onDraftCommentChange(value: string): void;
  onMarkReviewed(file: ReviewFile): Promise<void>;
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
  onSelectFile(path: string): void;
  onSelectThread(threadId: string): void;
  selected: boolean;
  selectedThreadId?: string;
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
                onKeyDown={(event) => {
                  if (isSubmitShortcut(event) && draftComment.trim() !== "") {
                    event.preventDefault();
                    void onCreateThread(file, "file");
                  }
                }}
                placeholder="Leave a file-level review thread"
                value={draftComment}
              />
              <div className="file-comment-submit">
                {actionError === undefined ? null : (
                  <span className="action-error">{actionError}</span>
                )}
                <Button
                  disabled={draftComment.trim() === ""}
                  onClick={() => void onCreateThread(file, "file")}
                  size="sm"
                  type="button"
                >
                  <MessageSquare size={15} />
                  Comment
                </Button>
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
              title={getViewedShortcutTitle(keyBindingStyle)}
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
              themeType: colorMode,
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
                onSelectThread={onSelectThread}
                selectedThreadId={selectedThreadId}
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
          <Tooltip key={patchset.patchsetNumber}>
            <TooltipTrigger
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
              type="button"
            >
              <span>PS {patchset.patchsetNumber}</span>
              <small>{patchset.headSha.slice(0, 7)}</small>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>
              {patchset.eventType}
              {patchset.forcePush ? " · force-push" : ""}
            </TooltipContent>
          </Tooltip>
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
  onSelectThread,
  selectedThreadId,
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
  onSelectThread(threadId: string): void;
  selectedThreadId?: string;
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
          onKeyDown={(event) => {
            if (isSubmitShortcut(event) && draftComment.trim() !== "") {
              event.preventDefault();
              void onCreateThread(file);
            }
          }}
          placeholder="Leave a review comment"
          value={draftComment}
        />
        <div>
          {actionError === undefined ? null : <span className="action-error">{actionError}</span>}
          <Button
            disabled={draftComment.trim() === ""}
            onClick={() => void onCreateThread(file)}
            size="sm"
            type="button"
          >
            <MessageSquare size={15} />
            Comment
          </Button>
        </div>
      </section>
    );
  }

  return (
    <ThreadCard
      onReply={onReply}
      onResolve={onResolve}
      onSelect={onSelectThread}
      selected={annotation.metadata.thread.id === selectedThreadId}
      thread={annotation.metadata.thread}
    />
  );
}

function ThreadCard({
  onReply,
  onResolve,
  onSelect,
  selected,
  thread,
}: {
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string): Promise<void>;
  onSelect(threadId: string): void;
  selected: boolean;
  thread: ReviewThread;
}) {
  const [replyDraft, setReplyDraft] = useState("");

  return (
    <article
      className={`thread ${selected ? "selected" : ""}`}
      id={threadSectionId(thread.id)}
      onClick={() => onSelect(thread.id)}
    >
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
          <div className="comment-content">
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
            <p className="comment-body">{comment.body}</p>
          </div>
        </div>
      ))}
      {thread.status === "open" ? (
        <div className="thread-actions">
          <input
            aria-label="Reply"
            onChange={(event) => setReplyDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event) && replyDraft.trim() !== "") {
                event.preventDefault();
                void onReply(thread.id, replyDraft).then(() => {
                  setReplyDraft("");
                });
              }
            }}
            placeholder="Reply"
            value={replyDraft}
          />
          <Button
            onClick={() =>
              void onReply(thread.id, replyDraft).then(() => {
                setReplyDraft("");
              })
            }
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Send size={14} />
          </Button>
          <Button
            onClick={() => void onResolve(thread.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Check size={14} />
            Resolve
          </Button>
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

type KeyboardBindingStyle = "github" | "vscode";

type ColorMode = "dark" | "light" | "system";

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

type ReviewTone = "danger" | "info" | "muted" | "success" | "warning";

type ReviewNavigationTarget =
  | {
      path: string;
      type: "file";
    }
  | {
      path: string;
      threadId: string;
      type: "thread";
    };

type ReviewReadinessState =
  | "blocked"
  | "limited"
  | "ready"
  | "waiting-on-author"
  | "waiting-on-review";

type ReviewReadinessItem = {
  detail: string;
  id: string;
  label: string;
  target?: ReviewNavigationTarget;
};

type ReviewReadiness = {
  blockers: ReviewReadinessItem[];
  detail: string;
  label: string;
  satisfied: ReviewReadinessItem[];
  state: ReviewReadinessState;
  tone: ReviewTone;
};

type ReviewChip = {
  id: string;
  label: string;
  target?: ReviewNavigationTarget;
  tone: ReviewTone;
  value: string;
};

type ReviewModel = {
  chips: ReviewChip[];
  firstActionTarget?: ReviewNavigationTarget;
  readiness: ReviewReadiness;
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

function createFileTarget(path: string): ReviewNavigationTarget {
  return {
    path,
    type: "file",
  };
}

function createThreadTarget(thread: ReviewThread): ReviewNavigationTarget | undefined {
  const path = thread.anchor.currentPath ?? thread.anchor.originalPath;
  if (path === "") {
    return undefined;
  }

  return {
    path,
    threadId: thread.id,
    type: "thread",
  };
}

function buildReviewIssueTargets(snapshot: ReviewSnapshot): ReviewNavigationTarget[] {
  const targets: ReviewNavigationTarget[] = [];

  for (const file of snapshot.files) {
    targets.push(
      ...snapshot.threads
        .filter(
          (thread) =>
            thread.status === "open" &&
            (thread.anchor.currentPath === file.path || thread.anchor.originalPath === file.path),
        )
        .toSorted(
          (left, right) =>
            (left.anchor.currentLine ?? left.anchor.originalLine) -
            (right.anchor.currentLine ?? right.anchor.originalLine),
        )
        .map(createThreadTarget)
        .filter(isDefined),
    );

    if (file.markState !== "current" && snapshot.capabilities.mode === "indexed") {
      targets.push(createFileTarget(file.path));
    }
  }

  return targets;
}

function getCurrentReviewTargetIndex(
  targets: ReviewNavigationTarget[],
  selectedIssueKey: string | undefined,
  selectedThreadId: string | undefined,
): number {
  const issueIndex = targets.findIndex((target) => reviewTargetKey(target) === selectedIssueKey);
  if (issueIndex !== -1) {
    return issueIndex;
  }

  const threadIndex = targets.findIndex(
    (target) => target.type === "thread" && target.threadId === selectedThreadId,
  );
  if (threadIndex !== -1) {
    return threadIndex;
  }

  return -1;
}

function reviewTargetKey(target: ReviewNavigationTarget): string {
  return target.type === "thread" ? `thread:${target.threadId}` : `file:${target.path}`;
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function getAttentionSummary(snapshot: ReviewSnapshot, showTurnState: boolean): string {
  if (!showTurnState) {
    return snapshot.capabilities.mode === "public" ? "Attention limited" : "Attention unavailable";
  }

  if (snapshot.attention.isViewerTurn) {
    return "Your turn";
  }

  if (snapshot.attention.members.length === 0) {
    return "No active turn";
  }

  const names = snapshot.attention.members
    .slice(0, 2)
    .map((member) => `@${member.login}`)
    .join(", ");
  return snapshot.attention.members.length > 2
    ? `Waiting on ${names} +${snapshot.attention.members.length - 2}`
    : `Waiting on ${names}`;
}

function getAttentionDetail(snapshot: ReviewSnapshot, showTurnState: boolean): string {
  if (!showTurnState) {
    return snapshot.capabilities.limitations[0] ?? "Sign in and use an indexed PR to manage turns.";
  }

  if (snapshot.attention.members.length === 0) {
    return "No one is currently expected to act.";
  }

  return snapshot.attention.members.map((member) => member.reason).join(", ");
}

function isOlderThanHours(value: string, hours: number): boolean {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && Date.now() - timestamp > hours * 60 * 60 * 1000;
}

function isSubmitShortcut(event: ReactKeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

function getViewedShortcutTitle(keyBindingStyle: KeyboardBindingStyle): string {
  return keyBindingStyle === "vscode"
    ? "Mark this file as reviewed (Ctrl/Cmd+K, V)"
    : "Mark this file as reviewed (V)";
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? target.closest("input, textarea, select, [contenteditable='true']") !== null
    : false;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
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

function readKeyboardBindingStyle(): KeyboardBindingStyle {
  const value = readLocalPreference("clearance.keyBindingStyle");
  return isKeyboardBindingStyle(value) ? value : "vscode";
}

function isKeyboardBindingStyle(value: unknown): value is KeyboardBindingStyle {
  return value === "github" || value === "vscode";
}

function applyColorMode(mode: ColorMode): void {
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.classList.toggle("dark", shouldUseDarkColorMode(mode));
}

function shouldUseDarkColorMode(mode: ColorMode): boolean {
  if (mode === "dark") {
    return true;
  }

  return (
    mode === "system" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function readColorMode(): ColorMode {
  const rawValue = readLocalPreference("clearance.colorMode");
  return isColorMode(rawValue) ? rawValue : defaultColorMode;
}

function isColorMode(value: unknown): value is ColorMode {
  return value === "dark" || value === "light" || value === "system";
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

applyColorMode(readColorMode());
createRoot(document.querySelector("#root") as HTMLElement).render(<App />);
