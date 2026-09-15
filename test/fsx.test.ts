import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextAtomic } from "../src/shared/fsx.ts";

describe("writeTextAtomic", () => {
	test("concurrent saves to one path both succeed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wp-fsx-"));
		try {
			const path = join(dir, "file.json");
			await Promise.all([
				writeTextAtomic(path, "{\"writer\":1}\n"),
				writeTextAtomic(path, "{\"writer\":2}\n"),
				writeTextAtomic(path, "{\"writer\":3}\n"),
			]);
			const text = await readFile(path, "utf8");
			expect(["{\"writer\":1}\n", "{\"writer\":2}\n", "{\"writer\":3}\n"]).toContain(text);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
