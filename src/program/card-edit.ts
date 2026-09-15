import type { GateResult } from "../shared/types.ts";

const STATE_LINE_RE = /^##\s+State:.*$/m;

export function setCardState(text: string, state: string): string {
	if (STATE_LINE_RE.test(text)) {
		return text.replace(STATE_LINE_RE, `## State: ${state}`);
	}
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	return `${trimmed}\n\n## State: ${state}\n`;
}

export function appendHarnessEvidence(text: string, lines: string[]): string {
	const block = ["## Harness evidence", "", ...lines.map((line) => `- ${line}`), ""];
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	return `${trimmed}\n\n${block.join("\n")}`;
}

export function gateEvidenceLines(gates: GateResult[], label: string): string[] {
	if (gates.length === 0) return [`${label}: no gates configured`];
	return gates.map((gate) => {
		const verdict = gate.code === 0 ? "passed" : `FAILED (exit ${gate.code})`;
		const firstLine = gate.tail.trim().split("\n").find((line) => line.trim().length > 0) ?? "";
		return `${label}: \`${gate.command}\` ${verdict}${firstLine ? ` — ${firstLine.trim().slice(0, 160)}` : ""}`;
	});
}

