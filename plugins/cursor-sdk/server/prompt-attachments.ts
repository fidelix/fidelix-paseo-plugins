import type { ProviderContent } from "@getpaseo/plugin/server/provider";

export type PromptAttachment = Exclude<ProviderContent, { type: "image" }>;

interface ForgeLabels {
  displayName: string;
  changeRequestAbbrev: string;
  changeRequestNumberPrefix: string;
}

// Mirrors Paseo's forge manifest; renderPromptAttachmentAsText is not exported to plugins.
const FORGES: Record<string, ForgeLabels> = {
  github: {
    displayName: "GitHub",
    changeRequestAbbrev: "PR",
    changeRequestNumberPrefix: "#",
  },
  gitlab: {
    displayName: "GitLab",
    changeRequestAbbrev: "MR",
    changeRequestNumberPrefix: "!",
  },
  gitea: {
    displayName: "Gitea",
    changeRequestAbbrev: "PR",
    changeRequestNumberPrefix: "#",
  },
  forgejo: {
    displayName: "Forgejo",
    changeRequestAbbrev: "PR",
    changeRequestNumberPrefix: "#",
  },
  codeberg: {
    displayName: "Codeberg",
    changeRequestAbbrev: "PR",
    changeRequestNumberPrefix: "#",
  },
};

function forgeLabels(forge: string | undefined): ForgeLabels {
  return (
    (forge && FORGES[forge]) || {
      displayName: forge ?? "Forge",
      changeRequestAbbrev: "PR",
      changeRequestNumberPrefix: "#",
    }
  );
}

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

function forgeItem(
  heading: string,
  url: string,
  details: Array<[string, string | null | undefined]>,
  body: string | null | undefined,
): string {
  const lines = [heading, url];
  for (const [label, value] of details)
    if (value) lines.push(`${label}: ${value}`);
  if (body) lines.push("", body);
  return lines.join("\n");
}

/** Text rendering of a non-text, non-image prompt part, matching Paseo's built-in providers. */
export function renderAttachmentAsText(part: PromptAttachment): string {
  switch (part.type) {
    case "forge_change_request":
    case "github_pr": {
      const forge = forgeLabels(
        part.type === "github_pr" ? "github" : part.forge,
      );
      return forgeItem(
        `${forge.displayName} ${forge.changeRequestAbbrev} ${forge.changeRequestNumberPrefix}${part.number}: ${part.title}`,
        part.url,
        [
          [
            "Project",
            part.type === "forge_change_request" ? part.projectPath : undefined,
          ],
          ["Base", part.baseRefName],
          ["Head", part.headRefName],
        ],
        part.body,
      );
    }
    case "forge_issue":
    case "github_issue": {
      const forge = forgeLabels(
        part.type === "github_issue" ? "github" : part.forge,
      );
      return forgeItem(
        `${forge.displayName} Issue #${part.number}: ${part.title}`,
        part.url,
        [
          [
            "Project",
            part.type === "forge_issue" ? part.projectPath : undefined,
          ],
        ],
        part.body,
      );
    }
    case "text":
      return part.text;
    case "review": {
      const lines = [
        `Paseo review attachment (${part.mode})`,
        `CWD: ${part.cwd}`,
      ];
      if (part.baseRef) lines.push(`Base: ${part.baseRef}`);
      part.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          const oldLn = (line.oldLineNumber?.toString() ?? "-").padStart(2);
          const newLn = (line.newLineNumber?.toString() ?? "-").padStart(2);
          lines.push(
            `${isTarget ? "> " : "  "}${oldLn} ${newLn} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`,
          );
        }
      });
      return lines.join("\n");
    }
    case "uploaded_file":
      return [
        `Uploaded file: ${part.fileName}`,
        `Path: ${part.path}`,
        `MIME: ${part.mimeType}`,
        `Size: ${part.size} bytes`,
      ].join("\n");
  }
}
