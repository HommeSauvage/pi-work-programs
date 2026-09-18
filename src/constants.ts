export const EXTENSION_NAME = "pi-work-programs";

export const SUBAGENT_RPC_VERSION = 1;
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export const INTERCOM_TOOL_NAME = "intercom";
export const INTERCOM_READY_EVENT = "intercom:extension-registry-ready";

export const SESSION_ENTRY_TYPE = "work-program";
export const BRIEF_CUSTOM_TYPE = "work-program-brief";
export const DECISION_CUSTOM_TYPE = "work-program-decision";

export const RUNTIME_DIR = ".runtime";
export const LEDGER_FILE = "program.json";
export const REVIEWS_DIR = "reviews";
export const PLAN_FILE = "plan.md";
export const PROGRESS_FILE = "progress.md";
export const ATLAS_FILE = "atlas.md";
export const TASKS_DIR = "tasks";
export const RUNTIME_GITIGNORE = "*\n";

export const RPC_TIMEOUT_MS = 8_000;
export const STATUS_TIMEOUT_MS = 30_000;
export const GATE_TIMEOUT_MS = 30 * 60_000;

export const MAX_REVIEW_CHARS = 60_000;
export const MAX_DIGEST_CHARS = 1_400;
export const MAX_OUTPUT_TAIL_CHARS = 8_000;

/** Safety-tick interval for the drive loop while a program is active. */
export const DRIVE_TICK_MS = 20_000;

/**
 * Decision packets are wake-ups, not the primary channel (the per-turn program
 * brief lists open decisions for free). So a packet waits until the session is
 * idle: a decision answered during the agent's current turn is never announced
 * afterwards. The force age escapes a session that never goes idle.
 */
export const PACKET_WAKE_MIN_AGE_MS = 15_000;
export const PACKET_WAKE_FORCE_AGE_MS = 180_000;
