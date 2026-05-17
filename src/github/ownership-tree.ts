import { Buffer } from "node:buffer";

import {
  buildOwnershipTree,
  discoverOwnershipFiles,
  isLoadableOwnershipFile,
  type OwnershipFileContent,
  type OwnershipTree,
  type PreparedOwnershipFile,
  type RepositoryTreeEntry,
} from "../owners/index.js";

export type RepositoryRef = {
  owner: string;
  ref: string;
  repo: string;
};

export type OwnershipTreeOctokit = {
  rest: {
    git: {
      getBlob(parameters: { file_sha: string; owner: string; repo: string }): Promise<{
        data: {
          content?: string;
          encoding?: string;
        };
      }>;
      getTree(parameters: {
        owner: string;
        recursive: "1";
        repo: string;
        tree_sha: string;
      }): Promise<{
        data: {
          tree: RepositoryTreeEntry[];
          truncated?: boolean;
        };
      }>;
    };
  };
};

export async function loadOwnershipTree(
  octokit: OwnershipTreeOctokit,
  repository: RepositoryRef,
): Promise<OwnershipTree> {
  const treeResponse = await getRepositoryTree(octokit, repository);
  if (!treeResponse.ok) {
    return {
      diagnostics: [treeResponse.diagnostic],
      files: [],
      truncated: false,
    };
  }

  const discovery = discoverOwnershipFiles(treeResponse.data.tree, {
    truncated: treeResponse.data.truncated,
  });
  const contents = await Promise.all(
    discovery.files
      .filter((file) => isLoadableOwnershipFile(file))
      .map((file) => loadOwnershipFileContent(octokit, repository, file)),
  );

  return buildOwnershipTree(discovery, contents);
}

async function getRepositoryTree(
  octokit: OwnershipTreeOctokit,
  repository: RepositoryRef,
): Promise<
  | {
      data: {
        tree: RepositoryTreeEntry[];
        truncated?: boolean;
      };
      ok: true;
    }
  | {
      diagnostic: {
        filePath: string;
        message: string;
        schemaPath: string;
        severity: "error";
      };
      ok: false;
    }
> {
  try {
    const response = await octokit.rest.git.getTree({
      owner: repository.owner,
      recursive: "1",
      repo: repository.repo,
      tree_sha: repository.ref,
    });

    return {
      data: response.data,
      ok: true,
    };
  } catch (error) {
    return {
      diagnostic: {
        filePath: ".",
        message: `failed to discover OWNERS.toml files: ${getErrorMessage(error, "tree lookup failed")}`,
        schemaPath: "$",
        severity: "error",
      },
      ok: false,
    };
  }
}

async function loadOwnershipFileContent(
  octokit: OwnershipTreeOctokit,
  repository: RepositoryRef,
  file: PreparedOwnershipFile,
): Promise<OwnershipFileContent> {
  const sha = file.sha;
  if (sha === undefined) {
    return {
      error: "OWNERS.toml entry is missing a blob sha",
      path: file.path,
    };
  }

  try {
    const blobResponse = await octokit.rest.git.getBlob({
      file_sha: sha,
      owner: repository.owner,
      repo: repository.repo,
    });

    return {
      path: file.path,
      source: decodeBlobContent(blobResponse.data),
    };
  } catch (error) {
    return {
      error: getErrorMessage(error, "failed to load OWNERS.toml"),
      path: file.path,
    };
  }
}

function decodeBlobContent(data: { content?: string; encoding?: string }): string {
  if (data.encoding !== "base64") {
    throw new Error(`expected base64 blob encoding, received ${data.encoding ?? "unknown"}`);
  }

  if (data.content === undefined) {
    throw new Error("blob response did not include content");
  }

  const content = data.content.replace(/\s/g, "");
  if (!isBase64(content)) {
    throw new Error("blob content is not valid base64");
  }

  return Buffer.from(content, "base64").toString("utf8");
}

function isBase64(value: string): boolean {
  return value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
