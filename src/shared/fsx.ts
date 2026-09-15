import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function readTextOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	// Unique per call: concurrent saves (a drive tick racing a tool mutation)
	// must never share a temp name — same-ms writers used to eat each other's
	// rename and crash with ENOENT.
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, path);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	const text = await readTextOrUndefined(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function listDirectory(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch {
		return [];
	}
}

