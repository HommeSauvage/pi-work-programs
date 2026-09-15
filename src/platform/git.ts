import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitOps } from "../shared/types.ts";
import { pathExists } from "../shared/fsx.ts";
import { oneLine } from "../shared/text.ts";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

const GIT_TIMEOUT_MS = 60_000;

export class Git implements GitOps {
	constructor(private readonly pi: ExtensionAPI) {}

	private async git(cwd: string, args: string[]): Promise<CommandResult> {
		const result = await this.pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
		return { code: result.killed ? -1 : result.code, stdout: result.stdout, stderr: result.stderr };
	}

	private async run(cwd: string, args: string[], errorLabel: string): Promise<CommandResult> {
		const result = await this.git(cwd, args);
		if (result.code !== 0) {
			const detail = result.code === -1 ? "command was killed or timed out" : oneLine(result.stderr.trim() || result.stdout.trim(), 300);
			throw new Error(`${errorLabel}: ${detail}`);
		}
		return result;
	}

	async statusPorcelain(cwd: string): Promise<string> {
		return (await this.run(cwd, ["status", "--porcelain"], "git status failed")).stdout;
	}

	async head(cwd: string): Promise<string> {
		return (await this.run(cwd, ["rev-parse", "HEAD"], "git rev-parse failed")).stdout.trim();
	}

	async currentBranch(cwd: string): Promise<string> {
		return (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], "git branch lookup failed")).stdout.trim();
	}

	async worktreeAdd(cwd: string, path: string, branch: string, baseRef: string): Promise<void> {
		await this.run(cwd, ["worktree", "add", "-b", branch, path, baseRef], `git worktree add failed for ${branch}`);
	}

	async worktreeRemove(cwd: string, path: string): Promise<void> {
		await this.run(cwd, ["worktree", "remove", "--force", path], "git worktree remove failed");
	}

	async branchDelete(cwd: string, branch: string): Promise<void> {
		const result = await this.git(cwd, ["branch", "-d", branch]);
		if (result.code === 0) return;
		await this.run(cwd, ["branch", "-D", branch], `git branch delete failed for ${branch}`);
	}

	async branchExists(cwd: string, branch: string): Promise<boolean> {
		const result = await this.git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return result.code === 0;
	}

	async diffStat(cwd: string, from: string, to: string): Promise<string> {
		return (await this.run(cwd, ["diff", "--stat", `${from}..${to}`], "git diff --stat failed")).stdout;
	}

	async commitLog(cwd: string, range: string): Promise<string> {
		const args = range.startsWith("-") ? ["log", "--oneline", range] : ["log", "--oneline", range];
		const result = await this.git(cwd, args);
		return result.code === 0 ? result.stdout : "";
	}

	async mergeNoCommit(cwd: string, branch: string): Promise<{ code: number; conflicted: string[]; output: string }> {
		const result = await this.git(cwd, ["merge", "--no-commit", "--no-ff", branch]);
		const conflicted = await this.unmergedPaths(cwd);
		return { code: result.code, conflicted, output: `${result.stdout}\n${result.stderr}`.trim() };
	}

	async isAncestor(cwd: string, ref: string, of: string): Promise<boolean> {
		const result = await this.git(cwd, ["merge-base", "--is-ancestor", ref, of]);
		return result.code === 0;
	}

	async mergeAbort(cwd: string): Promise<void> {
		await this.git(cwd, ["merge", "--abort"]);
	}

	async unmergedPaths(cwd: string): Promise<string[]> {
		const result = await this.git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	async merging(cwd: string): Promise<boolean> {
		const result = await this.git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		return result.code === 0;
	}

	/** True when nothing is staged. Checked instead of sniffing git's varying
	 *  "nothing to commit" message flavors (clean tree vs. untracked files). */
	async diffCachedQuiet(cwd: string): Promise<boolean> {
		const result = await this.git(cwd, ["diff", "--cached", "--quiet"]);
		return result.code === 0;
	}

	/** Paths git refuses to stage because a .gitignore rule covers them. */
	async ignoredPaths(cwd: string, paths: string[]): Promise<string[]> {
		if (paths.length === 0) return [];
		const result = await this.git(cwd, ["check-ignore", "--", ...paths]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	/**
	 * Commit program records without ever failing the card. Stages only what git
	 * can accept (existing, not ignored), commits when anything is staged, and
	 * reports the paths it had to skip. Repos that gitignore their program folder
	 * (`.agents/`) therefore record cards on disk with the records untracked —
	 * no force-add, no throw, no stuck merge.
	 */
	async commitRecords(cwd: string, message: string, paths: string[]): Promise<{ commit: string; skipped: string[] }> {
		const skipped: string[] = [];
		const stageable: string[] = [];
		const ignored = new Set(await this.ignoredPaths(cwd, paths));
		for (const path of paths) {
			if (ignored.has(path)) {
				skipped.push(path);
				continue;
			}
			if (!(await pathExists(path))) {
				skipped.push(path);
				continue;
			}
			stageable.push(path);
		}
		if (stageable.length > 0) {
			const add = await this.git(cwd, ["add", "--", ...stageable]);
			if (add.code !== 0) {
				// Belt and braces: an unexpected add failure must not fail the card.
				for (const path of stageable) skipped.push(path);
				return { commit: await this.head(cwd), skipped };
			}
		}
		if (await this.diffCachedQuiet(cwd)) return { commit: await this.head(cwd), skipped };
		const commit = await this.git(cwd, ["commit", "-m", message]);
		if (commit.code !== 0) {
			throw new Error(`git commit failed: ${oneLine(commit.stderr || commit.stdout, 300)}`);
		}
		return { commit: await this.head(cwd), skipped };
	}

	async commitPaths(cwd: string, message: string, paths: string[]): Promise<string> {
		if (paths.length > 0) {
			await this.run(cwd, ["add", "--", ...paths], "git add failed");
		}
		if (await this.diffCachedQuiet(cwd)) return this.head(cwd);
		const commit = await this.git(cwd, ["commit", "-m", message]);
		if (commit.code !== 0) {
			throw new Error(`git commit failed: ${oneLine(commit.stderr || commit.stdout, 300)}`);
		}
		return this.head(cwd);
	}

	async commitAll(cwd: string, message: string): Promise<string> {
		await this.run(cwd, ["add", "-A"], "git add failed");
		if (await this.diffCachedQuiet(cwd)) return this.head(cwd);
		const commit = await this.git(cwd, ["commit", "-m", message]);
		if (commit.code !== 0) {
			throw new Error(`git commit failed: ${oneLine(commit.stderr || commit.stdout, 300)}`);
		}
		return this.head(cwd);
	}

	/**
	 * Finalize a merge in progress (conflicts already resolved in the tree).
	 * Commits only what the merge staged — never `add`, so stray or untracked
	 * files (operator todos, lane droppings) can never enter merge commits.
	 * An open-but-empty merge carries nothing and is aborted instead of failed.
	 */
	async commitMerge(cwd: string): Promise<string> {
		const commit = await this.git(cwd, ["commit", "--no-edit"]);
		if (commit.code === 0) return this.head(cwd);
		if (await this.diffCachedQuiet(cwd)) {
			await this.git(cwd, ["merge", "--abort"]);
			return this.head(cwd);
		}
		throw new Error(`git merge commit failed: ${oneLine(commit.stderr || commit.stdout, 300)}`);
	}

	async revParse(cwd: string, ref: string): Promise<string> {
		return (await this.run(cwd, ["rev-parse", ref], `git rev-parse ${ref} failed`)).stdout.trim();
	}

	async changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
		const result = await this.git(cwd, ["diff", "--name-only", `${from}..${to}`]);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}
}
