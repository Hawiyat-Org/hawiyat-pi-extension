/**
 * Session scanner for the pi-stats extension.
 *
 * Walks every session JSONL under the (global) sessions root and aggregates
 * token/cost/message/tool usage per day. Results are cached per file keyed by
 * mtime+size so repeat scans only re-parse files that actually changed.
 *
 * The per-day breakdown is the single source of truth: report.ts derives all
 * rollups (sessions, projects, models, tools) from it, so range-filtered views
 * can never disagree with the overview.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, ".cache.json");
const CACHE_VERSION = 5;

export interface ModelAgg {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
}

export interface DayAgg {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	tokens: number;
	messages: number;
	user: number;
	assistant: number;
	tools: Record<string, number>;
	models: Record<string, ModelAgg>;
}

export interface SessionAgg {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	/** True for real pi sessions (has a `session` header), false for subagent artifacts. */
	hasHeader: boolean;
	created: number;
	modified: number;
	lastTs: number;
}

export interface FileAgg {
	mtimeMs: number;
	size: number;
	session: SessionAgg;
	days: Record<string, DayAgg>;
}

export interface ScanResult {
	files: FileAgg[];
	scanned: number;
	cached: number;
	total: number;
	root: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Accept both `cost: number` and `cost: { total: number }`. */
function usageCost(usage: any): number {
	const cost = usage?.cost;
	if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
	return num(cost?.total);
}

export function dayKey(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sessionsRoot(): string {
	const env = process.env;
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

export function emptyDay(): DayAgg {
	return {
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		tokens: 0,
		messages: 0,
		user: 0,
		assistant: 0,
		tools: {},
		models: {},
	};
}

function addUsage(day: DayAgg, key: string, usage: any): void {
	const input = num(usage?.input);
	const output = num(usage?.output);
	const cacheRead = num(usage?.cacheRead);
	const cacheWrite = num(usage?.cacheWrite);
	const reasoning = num(usage?.reasoning);
	const cost = usageCost(usage);

	const m = (day.models[key] ??= {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		cost: 0,
	});
	m.requests += 1;
	m.input += input;
	m.output += output;
	m.cacheRead += cacheRead;
	m.cacheWrite += cacheWrite;
	m.reasoning += reasoning;
	m.cost += cost;

	day.input += input;
	day.output += output;
	day.cacheRead += cacheRead;
	day.cacheWrite += cacheWrite;
	day.reasoning += reasoning;
	day.tokens += input + output + cacheRead + cacheWrite;
	day.cost += cost;
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) await walk(p);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
		}
	}
	await walk(root);
	return out;
}

async function parseFile(path: string, mtimeMs: number, size: number): Promise<FileAgg | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}

	const days: Record<string, DayAgg> = {};
	const session: SessionAgg = {
		path,
		id: "",
		cwd: "",
		hasHeader: false,
		created: 0,
		modified: mtimeMs,
		lastTs: 0,
	};
	let name: string | undefined;

	const getDay = (key: string): DayAgg => (days[key] ??= emptyDay());

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let e: any;
		try {
			e = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const type = e?.type;

		// Untyped lines: subagent artifact transcripts record usage at the top
		// level. Capture the spend but not the (internal) messages or a session.
		if (!type) {
			const usage = e?.usage;
			if (usage && typeof usage === "object") {
				const raw = typeof e.ts === "number" ? e.ts : Date.parse(e.timestamp ?? "");
				const at = Number.isFinite(raw) ? raw : 0;
				if (at) session.lastTs = Math.max(session.lastTs, at);
				addUsage(getDay(dayKey(at || session.created || mtimeMs)), `subagent/${e.model ?? "?"}`, usage);
			}
			continue;
		}

		if (type === "session") {
			session.hasHeader = true;
			if (typeof e.id === "string") session.id = e.id;
			if (typeof e.cwd === "string") session.cwd = e.cwd;
			const t = Date.parse(e.timestamp ?? "");
			if (Number.isFinite(t)) {
				session.created = t;
				session.lastTs = Math.max(session.lastTs, t);
			}
			continue;
		}
		if (type === "session_info") {
			if (typeof e.name === "string" && e.name) name = e.name;
			continue;
		}

		const parsed = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
		const t = Number.isFinite(parsed) ? parsed : 0;
		if (t) session.lastTs = Math.max(session.lastTs, t);

		if (type === "message") {
			const msg = e.message;
			if (!msg || typeof msg !== "object") continue;
			const day = getDay(dayKey(t || session.created));
			day.messages += 1;
			if (msg.role === "user") day.user += 1;
			else if (msg.role === "assistant") {
				day.assistant += 1;
				if (msg.usage) {
					addUsage(day, `${msg.provider ?? "?"}/${msg.responseModel ?? msg.model ?? "?"}`, msg.usage);
				}
			} else if (msg.role === "toolResult") {
				const toolName = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "unknown";
				day.tools[toolName] = (day.tools[toolName] ?? 0) + 1;
				if (msg.usage) addUsage(day, "summaries", msg.usage);
			}
			continue;
		}

		if (type === "usage") {
			addUsage(getDay(dayKey(t || session.created)), `${e.provider ?? "?"}/${e.model ?? "?"}`, e.usage);
			continue;
		}

		if ((type === "compaction" || type === "branch_summary") && e.usage) {
			addUsage(getDay(dayKey(t || session.created)), "summaries", e.usage);
		}
	}

	if (!session.id) session.id = basename(path).replace(/\.jsonl$/, "");
	if (!session.cwd) {
		// Fall back to the decoded project directory name (--home-morta-foo--).
		session.cwd = basename(dirname(path)).replace(/^--|--$/g, "").replace(/-/g, "/");
	}
	if (session.lastTs === 0) session.lastTs = session.created || mtimeMs;
	session.name = name;

	return { mtimeMs, size, session, days };
}

let cacheLoaded = false;
let cache: Record<string, FileAgg> = {};

function loadCache(): void {
	if (cacheLoaded) return;
	cacheLoaded = true;
	try {
		const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
		if (raw?.version === CACHE_VERSION && raw.files && typeof raw.files === "object") {
			cache = raw.files;
		}
	} catch {
		cache = {};
	}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced, non-blocking cache write so range cycling stays responsive. */
function scheduleSave(): void {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void (async () => {
			try {
				const tmp = `${CACHE_PATH}.tmp`;
				await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), files: cache }));
				await rename(tmp, CACHE_PATH);
			} catch {
				// Cache is best-effort.
			}
		})();
	}, 500);
	// Do not keep a short-lived `pi -p` process alive just to flush the cache.
	(saveTimer as { unref?: () => void }).unref?.();
}

export async function scanSessions(): Promise<ScanResult> {
	loadCache();
	const root = sessionsRoot();
	const paths = await collectJsonlFiles(root);
	const present = new Set(paths);
	const results: (FileAgg | undefined)[] = new Array(paths.length);

	let cursor = 0;
	let scanned = 0;
	let cached = 0;
	const workers = Array.from({ length: Math.min(8, Math.max(1, paths.length)) }, async () => {
		while (cursor < paths.length) {
			const index = cursor++;
			const path = paths[index];
			if (!path) continue;
			let st;
			try {
				st = await stat(path);
			} catch {
				continue;
			}
			const hit = cache[path];
			if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
				results[index] = hit;
				cached += 1;
				continue;
			}
			const agg = await parseFile(path, st.mtimeMs, st.size);
			if (agg) {
				results[index] = agg;
				cache[path] = agg;
			}
			scanned += 1;
		}
	});
	await Promise.all(workers);

	let pruned = false;
	for (const key of Object.keys(cache)) {
		if (!present.has(key)) {
			delete cache[key];
			pruned = true;
		}
	}
	if (scanned > 0 || pruned) scheduleSave();

	return { files: results.filter((f): f is FileAgg => !!f), scanned, cached, total: paths.length, root };
}
