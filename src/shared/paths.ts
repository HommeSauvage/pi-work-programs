import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function userAgentDir(): string {
	const env = process.env.PI_AGENT_DIR ?? process.env.PI_CONFIG_DIR;
	if (env && env.trim().length > 0) return env;
	return join(homedir(), ".pi", "agent");
}

export function userSettingsPath(): string {
	return join(userAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string, configDirName: string): string {
	return join(cwd, configDirName, "settings.json");
}

export function defaultWorktreeDir(repoDir: string): string {
	const repoName = repoDir.split("/").filter(Boolean).pop() ?? "repo";
	return join(userAgentDir(), "work-programs", "worktrees", repoName);
}

export function resolveProgramDir(cwd: string, dir: string): string {
	return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

export function defaultLaneBranch(baseBranch: string, cardId: string): string {
	const base = baseBranch.trim().length > 0 ? baseBranch.trim() : "work-program";
	return `${base}-card-${cardId}`;
}
