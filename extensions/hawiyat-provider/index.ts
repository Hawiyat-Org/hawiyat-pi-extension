/**
 * Hawiyat provider for the LiteLLM gateway at https://ai.hawiyat.cloud.
 *
 * The gateway exposes a different model list per API key, so the catalog is
 * fetched on refresh from /v1/models (key-scoped) and enriched with
 * /model_group/info (mode, vision, reasoning, cost). The last good catalog is
 * cached in ~/.pi/agent/hawiyat-models.json for startup and offline use.
 *
 * Streaming quirk: the gateway emits reasoning as JSON chunks but plain content
 * as raw `data: <token>` records, where a token may contain literal newlines.
 * pi only accepts OpenAI JSON chunks, so the fetch wrapper re-encodes raw
 * tokens into chat.completion.chunk deltas.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "hawiyat";
const PROVIDER_NAME = "Hawiyat";
const ORIGIN = "https://ai.hawiyat.cloud";
const BASE_URL = `${ORIGIN}/v1`;
const CACHE_PATH = join(homedir(), ".pi", "agent", "hawiyat-models.json");
const AGENT_DIR = dirname(CACHE_PATH);
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const NON_CHAT_MODES = new Set([
	"embedding",
	"image_generation",
	"image_edit",
	"audio_transcription",
	"audio_speech",
	"moderation",
	"rerank",
	"video_generation",
]);

/** Fallback filter for entries whose mode is unknown. */
const NON_CHAT_ID = /(^text-embedding|^tts-|whisper|transcribe|^gpt-image|dall-e|moderation|rerank)/i;

interface HawiyatModel {
	id: string;
	name: string;
	api: "openai-completions";
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: { supportsDeveloperRole: false; supportsReasoningEffort: false };
}

interface CacheFile {
	version: 1;
	checkedAt: number;
	models: HawiyatModel[];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Per-token price -> per-million-token price. */
function perMillion(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Number((value * 1_000_000).toFixed(4))
		: 0;
}

function toModel(id: string, entry: Record<string, unknown>, info: Record<string, unknown> | undefined): HawiyatModel | undefined {
	const mode = asString(info?.mode)?.toLowerCase();
	if (mode ? NON_CHAT_MODES.has(mode) : NON_CHAT_ID.test(id)) return undefined;

	return {
		id,
		name: id,
		api: "openai-completions",
		baseUrl: BASE_URL,
		reasoning: info?.supports_reasoning === true,
		input: info?.supports_vision === true ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(info?.input_cost_per_token),
			output: perMillion(info?.output_cost_per_token),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow:
			asPositiveNumber(entry.max_input_tokens) ??
			asPositiveNumber(info?.max_input_tokens) ??
			DEFAULT_CONTEXT_WINDOW,
		maxTokens:
			asPositiveNumber(entry.max_output_tokens) ??
			asPositiveNumber(info?.max_output_tokens) ??
			DEFAULT_MAX_TOKENS,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}

async function fetchModels(apiKey: string, signal: AbortSignal): Promise<HawiyatModel[]> {
	const headers = { Authorization: `Bearer ${apiKey}` };
	const response = await fetch(`${BASE_URL}/models`, { headers, signal });
	if (!response.ok) {
		throw new Error(`Hawiyat model list failed (${response.status} ${response.statusText})`);
	}

	const info = new Map<string, Record<string, unknown>>();
	try {
		const infoResponse = await fetch(`${ORIGIN}/model_group/info`, { headers, signal });
		const infoPayload = infoResponse.ok ? ((await infoResponse.json()) as { data?: unknown }) : undefined;
		if (Array.isArray(infoPayload?.data)) {
			for (const entry of infoPayload.data) {
				const name = asString((entry as Record<string, unknown>)?.model_group);
				if (name) info.set(name, entry as Record<string, unknown>);
			}
		}
	} catch {
		// Enrichment is optional.
	}

	const payload = (await response.json()) as { data?: unknown };
	const entries = Array.isArray(payload.data) ? payload.data : [];
	const models: HawiyatModel[] = [];
	const seen = new Set<string>();
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Record<string, unknown>;
		const id = asString(entry.id);
		if (!id || seen.has(id)) continue;
		const model = toModel(id, entry, info.get(id));
		if (!model) continue;
		seen.add(id);
		models.push(model);
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

function readCache(): HawiyatModel[] {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<CacheFile>;
		return parsed?.version === 1 && Array.isArray(parsed.models) ? parsed.models : [];
	} catch {
		return [];
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Best-effort key lookup for the initial catalog fetch before pi resolves auth. */
function resolveStartupKey(): string | undefined {
	const env = process.env.HAWIYAT_API_KEY?.trim();
	if (env) return env;

	const auth = readJson(join(AGENT_DIR, "auth.json")) as Record<string, { key?: unknown }> | undefined;
	const stored = auth?.hawiyat?.key;
	if (typeof stored === "string" && stored.trim()) return stored.trim();

	const config = readJson(join(AGENT_DIR, "models.json")) as { providers?: Record<string, { apiKey?: unknown }> } | undefined;
	const literal = config?.providers?.hawiyat?.apiKey;
	if (typeof literal === "string" && literal.trim() && !literal.startsWith("$") && !literal.startsWith("!")) {
		return literal.trim();
	}
	return undefined;
}

function writeCache(models: HawiyatModel[]): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, `${JSON.stringify({ version: 1, checkedAt: Date.now(), models } satisfies CacheFile, null, 2)}\n`);
	} catch {
		// Best-effort.
	}
}

type FetchLike = typeof globalThis.fetch;

const openAICompletions = openAICompletionsApi();

function isOpenAIChunk(payload: string): boolean {
	if (!payload.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		return Array.isArray(parsed.choices) || parsed.error !== undefined;
	} catch {
		return false;
	}
}

/**
 * The gateway frames every record as `data: <payload>\n\n` where a content
 * payload may contain newlines. Records are therefore separated by the literal
 * `\n\ndata:` boundary, and the final record is terminated by `\n\n`.
 */
function normalizeStreamingFetch(inner: FetchLike | undefined): FetchLike {
	const base = inner ?? globalThis.fetch;
	return async (input, init) => {
		const response = await base(input, init);
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.body || !contentType.includes("text/event-stream")) return response;

		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		const created = Math.floor(Date.now() / 1000);
		let buffer = "";
		let seq = 0;

		const drain = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean): void => {
			while (true) {
				const start = buffer.indexOf("data:");
				if (start === -1) {
					if (final) buffer = "";
					return;
				}
				if (start > 0) buffer = buffer.slice(start);

				const offset = buffer.startsWith("data: ") ? 6 : 5;
				const end = buffer.indexOf("\n\ndata:", offset);
				const payload = end === -1 ? (final ? buffer.slice(offset).replace(/\n\n$/, "") : undefined) : buffer.slice(offset, end);
				if (payload === undefined) return;
				buffer = end === -1 ? "" : buffer.slice(end + 2);
				if (payload.length === 0) continue;

				if (payload !== "[DONE]" && !isOpenAIChunk(payload)) {
					seq += 1;
					const chunk = JSON.stringify({
						id: `hawiyat-${seq}`,
						object: "chat.completion.chunk",
						created,
						choices: [{ index: 0, delta: { content: payload } }],
					});
					controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
				} else {
					controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
				}
			}
		};

		const transformed = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
				drain(controller, false);
			},
			flush(controller) {
				buffer += decoder.decode();
				drain(controller, true);
			},
		});

		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		headers.delete("transfer-encoding");
		return new Response(response.body.pipeThrough(transformed), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

export default async function (pi: ExtensionAPI) {
	let models = readCache();

	// On a cold start with no cache, fetch the key-scoped catalog now so models
	// are selectable during startup and for `--model` / `--list-models`.
	if (models.length === 0) {
		const apiKey = resolveStartupKey();
		if (apiKey) {
			try {
				models = await fetchModels(apiKey, AbortSignal.timeout(8_000));
				writeCache(models);
			} catch {
				models = [];
			}
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		api: "openai-completions",
		models,
		streamSimple: (model, context, options) =>
			openAICompletions.streamSimple(model as Model<"openai-completions">, context, {
				...options,
				fetch: normalizeStreamingFetch(options?.fetch),
			} as SimpleStreamOptions),
		refreshModels: async (context) => {
			const apiKey = context.credential?.key?.trim();
			if (!apiKey || !context.allowNetwork || context.signal.aborted) return models;
			try {
				const fetched = await fetchModels(apiKey, context.signal);
				if (fetched.length === 0) return models;
				models = fetched;
				writeCache(models);
				return models;
			} catch {
				return models;
			}
		},
	});
}
