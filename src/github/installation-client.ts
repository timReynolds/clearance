import type { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

type InstallationAuthentication = {
  token: string;
};

export async function createInstallationOctokit(
  app: App,
  installationId: number,
): Promise<Octokit> {
  const authentication = (await app.octokit.auth({
    installationId,
    type: "installation",
  })) as InstallationAuthentication;

  return new Octokit({
    auth: authentication.token,
  });
}
