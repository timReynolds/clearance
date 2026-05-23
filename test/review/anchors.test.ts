import { describe, expect, it } from "vitest";

import { relocateAnchor } from "../../src/review/index.js";

describe("review anchor relocation", () => {
  it("keeps anchors current when the source still appears in the same file", () => {
    expect(
      relocateAnchor(
        {
          originalLine: 10,
          originalPath: "src/app.ts",
          sourceText: "return renderReviewState(snapshot);",
        },
        [
          {
            path: "src/app.ts",
            patch: [
              "@@ -8,4 +8,4 @@",
              " export function view(snapshot) {",
              "+  return renderReviewState(snapshot);",
            ].join("\n"),
          },
        ],
      ),
    ).toEqual({
      confidence: 1,
      currentLine: 9,
      currentPath: "src/app.ts",
      status: "current",
    });
  });

  it("marks anchors moved when the source is found in another file", () => {
    expect(
      relocateAnchor(
        {
          currentPath: "src/old.ts",
          originalLine: 4,
          originalPath: "src/old.ts",
          sourceText: "const attention = computeAttentionSet(events);",
        },
        [
          { path: "src/old.ts", patch: "@@ -1,1 +1,1 @@\n export const empty = true;" },
          {
            path: "src/new.ts",
            patch: "@@ -20,1 +20,1 @@\n+const attention = computeAttentionSet(events);",
          },
        ],
      ),
    ).toEqual({
      confidence: 0.85,
      currentLine: 20,
      currentPath: "src/new.ts",
      status: "moved",
    });
  });

  it("marks anchors deleted when the file and source disappear", () => {
    expect(
      relocateAnchor(
        {
          currentPath: "src/old.ts",
          originalLine: 4,
          originalPath: "src/old.ts",
          sourceText: "const removed = true;",
        },
        [{ path: "src/new.ts", patch: "@@ -1,1 +1,1 @@\n+const kept = true;" }],
      ),
    ).toEqual({
      confidence: 0,
      status: "deleted",
    });
  });
});
