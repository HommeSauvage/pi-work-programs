export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return slug.length > 0 ? slug.slice(0, 64) : "work-program";
}

export function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `[…truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

export function oneLine(text: string, maxChars = 160): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length <= maxChars ? flattened : `${flattened.slice(0, maxChars - 1)}…`;
}

export function indent(text: string, prefix = "  "): string {
	return text
		.split("\n")
		.map((line) => (line.length > 0 ? `${prefix}${line}` : line))
		.join("\n");
}

/** Compact elapsed duration for run heartbeats and status lines: 45s, 12m, 3h, 2d. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Relative last-activity label for run heartbeats: "40s ago", "just now", "no activity yet". */
export function formatAgo(timestamp: number | undefined, now: number = Date.now()): string {
	if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return "no activity yet";
	const delta = now - timestamp;
	if (delta < 5_000) return "just now";
	return `${formatDuration(delta)} ago`;
}

export function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Compact token count for status/progress lines: 980, 41.2k, 16.6M. */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}
