// Run: node --test server/prompt-attachments.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { renderAttachmentAsText } from "./prompt-attachments.ts";

describe("renderAttachmentAsText", () => {
  it("renders a pasted GitHub issue link", () => {
    assert.equal(
      renderAttachmentAsText({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 42,
        title: "Crash on paste",
        url: "https://github.com/o/r/issues/42",
        body: "Steps...",
      }),
      "GitHub Issue #42: Crash on paste\nhttps://github.com/o/r/issues/42\n\nSteps...",
    );
  });

  it("uses forge labels for change requests", () => {
    assert.equal(
      renderAttachmentAsText({
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 7,
        title: "Fix",
        url: "https://gitlab.com/o/r/-/merge_requests/7",
        projectPath: "o/r",
        baseRefName: "main",
        headRefName: "fix",
        body: null,
      }),
      "GitLab MR !7: Fix\nhttps://gitlab.com/o/r/-/merge_requests/7\nProject: o/r\nBase: main\nHead: fix",
    );
  });

  it("describes uploaded files by path", () => {
    assert.equal(
      renderAttachmentAsText({
        type: "uploaded_file",
        id: "u1",
        fileName: "a.pdf",
        mimeType: "application/pdf",
        size: 3,
        path: "/tmp/a.pdf",
      }),
      "Uploaded file: a.pdf\nPath: /tmp/a.pdf\nMIME: application/pdf\nSize: 3 bytes",
    );
  });
});
