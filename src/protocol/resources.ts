import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_PROFILES } from "./profiles.ts";

export interface ProtocolResources {
	protocol: string;
	planTemplate: string;
	cardTemplate: string;
	reviews: Record<string, string>;
}

function resourceDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "resources");
}

let cached: ProtocolResources | undefined;

export function loadResources(): ProtocolResources {
	if (cached) return cached;
	const dir = resourceDir();
	const read = (name: string): string => readFileSync(resolve(dir, name), "utf8");
	const reviews: Record<string, string> = {};
	for (const profile of REVIEW_PROFILES) {
		reviews[profile] = read(`review-${profile}.md`);
	}
	cached = {
		protocol: read("protocol.md"),
		planTemplate: read("plan-template.md"),
		cardTemplate: read("card-template.md"),
		reviews,
	};
	return cached;
}
