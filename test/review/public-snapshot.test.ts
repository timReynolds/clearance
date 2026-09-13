import { describe, expect, it } from "vitest";

import { getPublicThreadRootCommentId } from "../../src/review/index.js";

describe("getPublicThreadRootCommentId", () => {
  it("extracts GitHub comment ids from public thread ids", () => {
    expect(getPublicThreadRootCommentId("github-comment-123")).toBe(123);
    expect(getPublicThreadRootCommentId("thread-123")).toBeUndefined();
  });
});
