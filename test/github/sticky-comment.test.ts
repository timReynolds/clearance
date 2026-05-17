import { describe, expect, it, vi } from "vitest";

import { upsertStickyClearanceComment, type StickyCommentOctokit } from "../../src/github/index.js";
import { renderClearanceComment, createEmptyClearanceState } from "../../src/state/index.js";

type ListComments = StickyCommentOctokit["rest"]["issues"]["listComments"];
type CreateComment = StickyCommentOctokit["rest"]["issues"]["createComment"];
type UpdateComment = StickyCommentOctokit["rest"]["issues"]["updateComment"];

describe("upsertStickyClearanceComment", () => {
  it("creates a sticky comment when none exists", async () => {
    const octokit = createCommentOctokitMock({
      comments: [{ body: "unrelated", id: 1 }],
    });
    const body = renderClearanceComment(createEmptyClearanceState());

    const result = await upsertStickyClearanceComment(
      octokit,
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      body,
    );

    expect(result).toEqual({
      commentId: 100,
      created: true,
      updated: false,
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      body,
      issue_number: 42,
      owner: "acme",
      repo: "clearance",
    });
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates the existing sticky comment instead of creating comment spam", async () => {
    const existingBody = renderClearanceComment(createEmptyClearanceState());
    const octokit = createCommentOctokitMock({
      comments: [
        { body: "unrelated", id: 1 },
        { body: existingBody, id: 2 },
      ],
    });
    const body = renderClearanceComment({
      ...createEmptyClearanceState(),
      warnings: [{ message: "new warning" }],
    });

    const result = await upsertStickyClearanceComment(
      octokit,
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      body,
    );

    expect(result).toEqual({
      commentId: 2,
      created: false,
      updated: true,
    });
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      body,
      comment_id: 2,
      owner: "acme",
      repo: "clearance",
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("paginates comments while looking for the sticky comment", async () => {
    const existingBody = renderClearanceComment(createEmptyClearanceState());
    const octokit = createCommentOctokitMock({
      comments: [
        ...Array.from({ length: 100 }, (_, index) => ({
          body: `unrelated ${index}`,
          id: index + 1,
        })),
        { body: existingBody, id: 101 },
      ],
    });

    const result = await upsertStickyClearanceComment(
      octokit,
      {
        owner: "acme",
        pullNumber: 42,
        repo: "clearance",
      },
      existingBody,
    );

    expect(result.commentId).toBe(101);
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({
      issue_number: 42,
      owner: "acme",
      page: 1,
      per_page: 100,
      repo: "clearance",
    });
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({
      issue_number: 42,
      owner: "acme",
      page: 2,
      per_page: 100,
      repo: "clearance",
    });
  });
});

function createCommentOctokitMock(options: {
  comments: Array<{
    body?: string;
    id: number;
  }>;
}): StickyCommentOctokit {
  const listComments = vi.fn<ListComments>(async ({ page = 1, per_page = 100 }) => {
    const start = (page - 1) * per_page;
    return {
      data: options.comments.slice(start, start + per_page),
    };
  });
  const createComment = vi.fn<CreateComment>(async ({ body }) => ({
    data: {
      body,
      id: 100,
    },
  }));
  const updateComment = vi.fn<UpdateComment>(async ({ body, comment_id }) => ({
    data: {
      body,
      id: comment_id,
    },
  }));

  return {
    rest: {
      issues: {
        createComment,
        listComments,
        updateComment,
      },
    },
  };
}
