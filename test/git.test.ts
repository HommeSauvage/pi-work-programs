import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Git } from "../src/platform/git.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function gitIn(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function scratchRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wp-real-git-"));
	tempDirs.push(root);
	gitIn(root, ["init", "-q", "-b", "main"]);
	gitIn(root, ["config", "user.email", "test@local"]);
	gitIn(root, ["config", "user.name", "test"]);
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	gitIn(root, ["add", "-A"]);
	gitIn(root, ["commit", "-q", "-m", "init"]);
	return root;
}

/** Git runs real commands through pi.exec; these tests need a real exec. */
function git(): Git {
	const pi = {
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			const result = spawnSync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				...(options?.timeout ? { timeout: options.timeout } : {}),
			});
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.status ?? -1,
				killed: result.signal !== null,
			};
		},
	} as unknown as ExtensionAPI;
	return new Git(pi);
}

describe("commitRecords (real git)", () => {
	test("commits tracked records normally", async () => {
		const root = await scratchRepo();
		await writeFile(join(root, "plan.md"), "plan\n", "utf8");
		const result = await git().commitRecords(root, "wp: card 01 done", [join(root, "plan.md")]);
		expect(result.skipped).toEqual([]);
		expect(result.commit).toBe(gitIn(root, ["rev-parse", "HEAD"]).trim());
		expect(gitIn(root, ["log", "-1", "--pretty=%s"]).trim()).toBe("wp: card 01 done");
	});

	test("keeps gitignored program records on disk without failing", async () => {
		const root = await scratchRepo();
		// The flytrader policy: the whole program tree is gitignored.
		await writeFile(join(root, ".gitignore"), ".agents/\n", "utf8");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-q", "-m", "ignore program records"]);
		await mkdir(join(root, ".agents", "work-programs", "demo", "tasks"), { recursive: true });
		const plan = join(root, ".agents", "work-programs", "demo", "plan.md");
		const card = join(root, ".agents", "work-programs", "demo", "tasks", "01-card.md");
		await writeFile(plan, "plan\n", "utf8");
		await writeFile(card, "## State: done\n", "utf8");
		const head = gitIn(root, ["rev-parse", "HEAD"]).trim();

		const result = await git().commitRecords(root, "wp: card 01 done", [plan, card]);

		expect(result.skipped.sort()).toEqual([card, plan].sort());
		// No throw, HEAD unchanged, and the records are still on disk.
		expect(result.commit).toBe(head);
		expect(await Bun.file(card).text()).toContain("State: done");
		expect(gitIn(root, ["status", "--porcelain"]).trim()).toBe("");
	});

	test("skips missing paths and commits the rest", async () => {
		const root = await scratchRepo();
		await writeFile(join(root, "plan.md"), "plan\n", "utf8");
		const missing = join(root, "tasks", "99-gone.md");
		const result = await git().commitRecords(root, "wp: card 02 done", [join(root, "plan.md"), missing]);
		expect(result.skipped).toEqual([missing]);
		expect(gitIn(root, ["log", "-1", "--pretty=%s"]).trim()).toBe("wp: card 02 done");
		expect(gitIn(root, ["show", "--name-only", "--pretty=", "HEAD"]).trim()).toBe("plan.md");
	});

	test("a fully ignored program still finalizes merges (no crash loop)", async () => {
		const root = await scratchRepo();
		await writeFile(join(root, ".gitignore"), ".agents/\n", "utf8");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-q", "-m", "ignore program records"]);
		// A lane with a real change to merge.
		gitIn(root, ["checkout", "-q", "-b", "main-card-01"]);
		await writeFile(join(root, "feature.ts"), "export const x = 1;\n", "utf8");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-q", "-m", "card 01 work"]);
		gitIn(root, ["checkout", "-q", "main"]);
		await mkdir(join(root, ".agents", "work-programs", "demo", "tasks"), { recursive: true });
		const card = join(root, ".agents", "work-programs", "demo", "tasks", "01-card.md");
		await writeFile(card, "## State: review\n", "utf8");
		gitIn(root, ["merge", "--no-commit", "--no-ff", "main-card-01"]);

		const api = git();
		const mergeCommit = await api.commitMerge(root);
		const records = await api.commitRecords(root, "wp: card 01 done", [card]);

		expect(mergeCommit).not.toBe("");
		expect(records.skipped).toEqual([card]);
		// The merge landed with the lane's change; only the records were skipped.
		expect(gitIn(root, ["show", "HEAD:feature.ts"]).trim()).toBe("export const x = 1;");
		expect(gitIn(root, ["log", "--oneline", "-3"]).includes("card 01 work")).toBe(true);
		// The merge is closed out and the working tree is clean.
		expect(gitIn(root, ["status", "--porcelain"]).trim()).toBe("");
	});
});

describe("commitMerge (real git)", () => {
	test("aborts an open-but-empty merge instead of failing", async () => {
		const root = await scratchRepo();
		gitIn(root, ["checkout", "-q", "-b", "main-empty"]);
		gitIn(root, ["commit", "-q", "--allow-empty", "-m", "empty lane commit"]);
		gitIn(root, ["checkout", "-q", "main"]);
		// Already-up-to-date merge leaves nothing staged but can open MERGE_HEAD.
		await writeFile(join(root, "README.md"), "# repo\n\nsame\n", "utf8");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-q", "-m", "master change"]);
		gitIn(root, ["checkout", "-q", "main-empty"]);
		await writeFile(join(root, "README.md"), "# repo\n\nsame\n", "utf8");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-q", "-m", "same change"]);
		gitIn(root, ["checkout", "-q", "main"]);

		const head = gitIn(root, ["rev-parse", "HEAD"]).trim();
		const commit = await git().commitMerge(root);
		expect(typeof commit).toBe("string");
		expect(commit).toBe(head);
	});
});
