import type { ParsedCard, ParsedPlan } from "../shared/types.ts";
import { findDependencyProblems, parseCard, parsePlan } from "./parse.ts";

export interface PlanValidation {
	plan: ParsedPlan;
	cards: ParsedCard[];
	problems: string[];
	warnings: string[];
}

export function validatePlanFiles(planText: string, cardFiles: Array<{ path: string; text: string }>): PlanValidation {
	const plan = parsePlan(planText);
	const problems = [...plan.problems];
	const warnings: string[] = [];
	const byPath = new Map(cardFiles.map((file) => [file.path, file.text]));
	const cards: ParsedCard[] = [];

	for (const entry of plan.cards) {
		const text = byPath.get(entry.path);
		if (text === undefined) {
			problems.push(`plan lists ${entry.path} but that card file does not exist`);
			continue;
		}
		const card = parseCard(entry.path, entry.id, text);
		cards.push(card);
	}

	const seenIds = new Set<string>();
	for (const card of cards) {
		if (seenIds.has(card.id)) problems.push(`duplicate card id ${card.id}`);
		seenIds.add(card.id);
		if (!card.hasDependsDeclaration) {
			problems.push(`card ${card.id} (${card.path}) has no explicit \`Depends on:\` declaration`);
		}
		if (card.state === "") problems.push(`card ${card.id} (${card.path}) has no \`State:\` line`);
		if (!/^##\s+Steps\b/im.test(byPath.get(card.path) ?? "")) {
			warnings.push(`card ${card.id} has no \`## Steps\` section`);
		}
		if (!/^##\s+Done when\b/im.test(byPath.get(card.path) ?? "")) {
			warnings.push(`card ${card.id} has no \`## Done when\` section`);
		}
	}

	const referenced = new Set(plan.cards.map((entry) => entry.path));
	for (const file of cardFiles) {
		if (!referenced.has(file.path)) {
			warnings.push(`${file.path} is not listed in the plan's card table (it will not run)`);
		}
	}

	const dependencyTable: Record<string, { dependsOn: string[] }> = {};
	for (const card of cards) dependencyTable[card.id] = { dependsOn: card.dependsOn };
	findDependencyProblems(problems, dependencyTable);

	if (cards.length === 0) problems.push("no cards to run");
	return { plan, cards, problems, warnings };
}

export function formatProblems(problems: string[], warnings: string[]): string {
	const lines: string[] = [];
	if (problems.length > 0) {
		lines.push("Blocking problems:");
		for (const problem of problems) lines.push(`- ${problem}`);
	}
	if (warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	if (lines.length === 0) lines.push("Plan validation passed.");
	return lines.join("\n");
}
