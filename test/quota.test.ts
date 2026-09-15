import { describe, expect, test } from "bun:test";
import { MAX_QUOTA_HOLD_MS, classifyQuota } from "../src/engine/driver.ts";

describe("classifyQuota", () => {
	test("parses the reported reset delay and quotes its source", () => {
		const hold = classifyQuota("GoUsageLimitError: 5-hour usage limit reached. Resets in 1hr 27min");
		expect(hold).toBeDefined();
		expect(hold?.hint).toBe("1hr 27min");
		// 1h27m + 60s slack
		expect(hold?.holdMs).toBe(87 * 60_000 + 60_000);
		expect(hold?.reason).toContain('parsed "1hr 27min"');
		expect(hold?.reason).toContain("GoUsageLimitError");
	});

	test("parses compact and second-granularity hints", () => {
		expect(classifyQuota("rate limit exceeded, retry in ~1h27m")?.holdMs).toBe(87 * 60_000 + 60_000);
		expect(classifyQuota("429 quota exhausted; try again in 120s")?.holdMs).toBe(120_000 + 60_000);
		expect(classifyQuota("usage limit reached, resets in 45min")?.holdMs).toBe(45 * 60_000 + 60_000);
	});

	test("caps an individual hold", () => {
		const hold = classifyQuota("quota exceeded, resets in 9hr");
		expect(hold?.holdMs).toBe(MAX_QUOTA_HOLD_MS);
	});

	test("a window name alone is not a delay", () => {
		// "5-hour" is the window, not a wait: blocking with the raw error is the
		// honest outcome when no reset delay is reported.
		expect(classifyQuota("GoUsageLimitError: 5-hour usage limit reached")).toBeUndefined();
	});

	test("non-quota errors are not held", () => {
		expect(classifyQuota("runner startup timed out")).toBeUndefined();
		expect(classifyQuota("assertion failed in applyUsage")).toBeUndefined();
		expect(classifyQuota("")).toBeUndefined();
	});
});
