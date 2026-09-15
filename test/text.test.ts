import { describe, expect, test } from "bun:test";
import { formatAgo, formatDuration } from "../src/shared/text.ts";

describe("formatDuration", () => {
	test("renders compact elapsed labels", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(12 * 60_000)).toBe("12m");
		expect(formatDuration(3 * 3_600_000)).toBe("3h");
		expect(formatDuration(3 * 86_400_000)).toBe("3d");
		expect(formatDuration(-1)).toBe("—");
	});
});

describe("formatAgo", () => {
	test("renders relative activity labels", () => {
		const now = Date.now();
		expect(formatAgo(now - 40_000, now)).toBe("40s ago");
		expect(formatAgo(now - 2_000, now)).toBe("just now");
		expect(formatAgo(undefined, now)).toBe("no activity yet");
		expect(formatAgo(0, now)).toBe("no activity yet");
	});
});
