/** Minimal YAML front-matter support (zero-dep, no gray-matter).
 *
 *  We only need the subset we write ourselves: flat `key: value` pairs, nested
 *  maps (`gates:\n  card:\n    - "bun run check"`), and arrays either inline
 *  (`[a, b]`) or as dash lists at any depth. Anything richer falls back to plain
 *  strings — the config normalizers clamp/ignore the rest, so a hand-edited file
 *  can never crash the drive.
 */

export interface FrontmatterResult {
	data: Record<string, unknown>;
	/** Body with the front-matter block removed. */
	body: string;
	/** Raw inner text of the front-matter block (without --- fences), if any. */
	raw?: string;
}

const FENCE = "---";

export function parseFrontmatter(text: string): FrontmatterResult {
	const lines = text.split("\n");
	if (lines.length === 0 || lines[0]?.trim() !== FENCE) {
		return { data: {}, body: text };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (line.trim() === FENCE || line.trim() === "...") {
			end = i;
			break;
		}
	}
	if (end === -1) return { data: {}, body: text };
	const raw = lines.slice(1, end).join("\n");
	const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
	let data: Record<string, unknown> = {};
	try {
		data = parseYamlSubset(raw);
	} catch {
		data = {};
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { data: {}, body, raw };
	}
	return { data: data as Record<string, unknown>, body, raw };
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	if (trimmed === "true" || trimmed === "yes" || trimmed === "on") return true;
	if (trimmed === "false" || trimmed === "no" || trimmed === "off") return false;
	if (trimmed === "null" || trimmed === "~" || trimmed === "—" || trimmed === "-") return null;
	// Card ids are zero-padded ("01", "08.5"): keep leading-zero numerics as strings.
	if (/^[+-]?0\d/.test(trimmed)) return trimmed;
	if (/^[+-]?\d+$/.test(trimmed)) {
		const num = Number.parseInt(trimmed, 10);
		return Number.isSafeInteger(num) ? num : trimmed;
	}
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
		const num = Number(trimmed);
		return Number.isFinite(num) ? num : trimmed;
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (inner.length === 0) return [];
		return splitInlineList(inner).map((entry) => parseScalar(entry) as string).filter((entry) => String(entry).length > 0);
	}
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		const inner = trimmed.slice(1, -1).trim();
		if (inner.length === 0) return {};
		const out: Record<string, unknown> = {};
		for (const part of splitInlineList(inner)) {
			const colon = part.indexOf(":");
			if (colon === -1) continue;
			const key = part.slice(0, colon).trim().replace(/^["']|["']$/g, "");
			if (!key) continue;
			out[key] = parseScalar(part.slice(colon + 1).trim());
		}
		return out;
	}
	return trimmed;
}

function splitInlineList(inner: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	let quote: string | undefined;
	for (const char of inner) {
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "[" || char === "{") depth += 1;
		if (char === "]" || char === "}") depth -= 1;
		if (char === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) parts.push(current.trim());
	return parts;
}

function indentOf(line: string): number {
	const match = /^(\s*)/.exec(line);
	return match?.[1]?.replace(/\t/g, "  ").length ?? 0;
}

/** Tiny YAML subset: scalars, nested maps, inline arrays, dash lists at any depth. */
function parseYamlSubset(raw: string): Record<string, unknown> {
	const parsed = parseYamlBlock(raw.split("\n"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
}

/** Strip the block's own indentation so nested lines start at column 0. */
function dedentBlock(lines: string[]): string[] {
	const indents = lines.filter((line) => line.trim().length > 0).map(indentOf);
	if (indents.length === 0) return lines;
	const min = Math.min(...indents);
	if (min === 0) return lines;
	return lines.map((line) => {
		let remaining = min;
		let rest = line;
		while (remaining > 0 && (rest.startsWith(" ") || rest.startsWith("\t"))) {
			const char = rest[0] ?? "";
			rest = rest.slice(1);
			remaining -= char === "\t" ? 2 : 1;
		}
		return rest;
	});
}

/** Parse an already-dedented block: either a dash list or a map. */
function parseYamlBlock(input: string[]): unknown {
	const first = input.find((line) => line.trim().length > 0);
	if (first === undefined) return "";
	if (first.trim().startsWith("- ")) {
		const items: unknown[] = [];
		let index = 0;
		while (index < input.length) {
			const line = input[index] ?? "";
			index += 1;
			if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
			if (!line.trim().startsWith("- ")) break;
			items.push(parseScalar(line.trim().slice(2).trim()));
		}
		return items;
	}
	const out: Record<string, unknown> = {};
	let i = 0;
	while (i < input.length) {
		const line = input[i] ?? "";
		const trimmed = line.trim();
		i += 1;
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim();
		if (!key || key.includes(" ")) continue;
		const rest = trimmed.slice(colon + 1).trim();
		if (rest.length > 0) {
			out[key] = parseScalar(rest);
			continue;
		}
		// Nested block: collect the indented children and recurse (dash list or map).
		const children: string[] = [];
		while (i < input.length) {
			const child = input[i] ?? "";
			if (child.trim().length === 0) {
				children.push(child);
				i += 1;
				continue;
			}
			if (indentOf(child) === 0) break;
			children.push(child);
			i += 1;
		}
		const meaningful = children.filter((child) => child.trim().length > 0);
		if (meaningful.length === 0) {
			out[key] = "";
			continue;
		}
		out[key] = parseYamlBlock(dedentBlock(meaningful));
	}
	return out;
}

function yamlScalar(value: unknown): string {
	if (value === null || value === undefined) return '""';
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
	const text = String(value);
	if (/^[A-Za-z0-9_./{}-]+$/.test(text) && text.length > 0) return text;
	return JSON.stringify(text);
}

/** Serialize a flat-ish record to canonical front-matter YAML. */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
				continue;
			}
			lines.push(`${key}:`);
			for (const entry of value) lines.push(`  - ${yamlScalar(entry)}`);
			continue;
		}
		if (typeof value === "object" && value !== null) {
			const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
			if (entries.length === 0) continue;
			lines.push(`${key}:`);
			for (const [childKey, childValue] of entries) {
				if (Array.isArray(childValue)) {
					if (childValue.length === 0) {
						lines.push(`  ${childKey}: []`);
						continue;
					}
					lines.push(`  ${childKey}:`);
					for (const entry of childValue) lines.push(`    - ${yamlScalar(entry)}`);
					continue;
				}
				if (typeof childValue === "object" && childValue !== null) {
					lines.push(`  ${childKey}: ${JSON.stringify(childValue)}`);
					continue;
				}
				lines.push(`  ${childKey}: ${yamlScalar(childValue)}`);
			}
			continue;
		}
		lines.push(`${key}: ${yamlScalar(value)}`);
	}
	return lines.join("\n");
}

/** Replace the front-matter block wholesale (deletions stick). Empty data removes the block. */
export function setFrontmatter(text: string, data: Record<string, unknown>): string {
	const parsed = parseFrontmatter(text);
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value !== undefined) clean[key] = value;
	}
	const yaml = stringifyFrontmatter(clean);
	const body = parsed.body.replace(/^\n+/, "");
	if (yaml.trim().length === 0) return body;
	return `---\n${yaml}\n---\n${body.length > 0 ? `\n${body}` : ""}`;
}

/** Set (or replace) the front-matter block, preserving the body. */
export function upsertFrontmatter(text: string, data: Record<string, unknown>): string {
	const parsed = parseFrontmatter(text);
	const merged = { ...parsed.data, ...data };
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) delete merged[key];
	}
	const yaml = stringifyFrontmatter(merged);
	const body = parsed.body.replace(/^\n+/, "");
	if (yaml.trim().length === 0) return body;
	return `---\n${yaml}\n---\n${body.length > 0 ? `\n${body}` : ""}`;
}

/** Merge a patch into existing front matter (shallow per top-level key, deep for one-level maps). */
export function mergeFrontmatterData(
	existing: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existing };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			delete merged[key];
			continue;
		}
		const current = merged[key];
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			typeof current === "object" &&
			current !== null &&
			!Array.isArray(current)
		) {
			merged[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
			continue;
		}
		merged[key] = value;
	}
	return merged;
}
