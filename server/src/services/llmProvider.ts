import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { OpenRouter } from '@openrouter/sdk';

const execFileAsync = promisify(execFile);

type Message = {
  role: 'system' | 'user';
  content: string;
};

type OpenClawCallOptions = {
  agentId?: string;
  useLocal?: boolean;
  timeoutMs?: number;
  sessionPrefix?: string;
};

export type StructuredGenerationOptions = {
  maxTokens?: number;
  temperature?: number;
  openclaw?: OpenClawCallOptions;
};

const OPENCLAW_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_TIMEOUT_MS || '180000', 10);
const OPENCLAW_FALLBACK_AGENT_ID = process.env.OPENCLAW_FALLBACK_AGENT_ID || 'main';
const OPENCLAW_ANALYSIS_AGENT_ID = process.env.OPENCLAW_ANALYSIS_AGENT_ID || OPENCLAW_FALLBACK_AGENT_ID;
const OPENCLAW_DETAIL_AGENT_ID = process.env.OPENCLAW_DETAIL_AGENT_ID || process.env.OPENCLAW_AGENT_ID || 'bim-tender';
const openClawLaneLocks = new Map<string, Promise<void>>();

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function getAIProvider(): 'openclaw' | 'openrouter' {
  return process.env.AI_PROVIDER === 'openclaw' ? 'openclaw' : 'openrouter';
}

function hasUsableOpenRouterKey(): boolean {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return Boolean(key && key !== 'your_openrouter_api_key_here');
}

export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) return objectMatch[0];
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  return trimmed;
}

function tryParseJsonFromCandidate(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function extractEmbeddedJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  const whole = tryParseJsonFromCandidate(trimmed);
  if (whole !== undefined) return whole;

  for (let start = 0; start < trimmed.length; start += 1) {
    const opener = trimmed[start];
    if (opener !== '{' && opener !== '[') continue;

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let end = start; end < trimmed.length; end += 1) {
      const char = trimmed[end];
      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === '\\') {
          escaping = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJsonFromCandidate(trimmed.slice(start, end + 1));
          if (parsed !== undefined) {
            return parsed;
          }
          break;
        }
      }
    }
  }

  const extracted = extractJsonPayload(trimmed);
  if (extracted !== trimmed) {
    return tryParseJsonFromCandidate(extracted);
  }

  return undefined;
}

function pickPayloadText(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined;
  const payloads = (candidate as { payloads?: Array<{ text?: unknown }> }).payloads;
  const firstText = payloads?.find((item) => typeof item?.text === 'string' && item.text.trim())?.text;
  return typeof firstText === 'string' ? firstText : undefined;
}

async function callOpenRouter(messages: Message[], maxTokens: number, temperature: number): Promise<string> {
  const openRouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY ?? ''
  });

  const result = await openRouter.chat.send({
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2',
    messages,
    temperature,
    maxTokens
  });

  const rawContent = result.choices[0]?.message?.content || '';
  return typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
}

function getExecErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const detail = error as { message?: string; stdout?: string; stderr?: string };
  return [detail.message, detail.stderr, detail.stdout].filter(Boolean).join('\n');
}

function shouldRetryWithFallbackAgent(error: unknown, configuredAgentId: string): boolean {
  if (!configuredAgentId || configuredAgentId === OPENCLAW_FALLBACK_AGENT_ID) return false;
  return /Unknown agent id/i.test(getExecErrorText(error));
}

export function getOpenClawAnalysisOptions(overrides?: Partial<OpenClawCallOptions>): OpenClawCallOptions {
  return {
    agentId: OPENCLAW_ANALYSIS_AGENT_ID,
    useLocal: parseBooleanEnv(process.env.OPENCLAW_ANALYSIS_LOCAL, true),
    timeoutMs: OPENCLAW_TIMEOUT_MS,
    sessionPrefix: 'analysis',
    ...overrides,
  };
}

export function getOpenClawDetailOptions(overrides?: Partial<OpenClawCallOptions>): OpenClawCallOptions {
  return {
    agentId: OPENCLAW_DETAIL_AGENT_ID,
    useLocal: parseBooleanEnv(process.env.OPENCLAW_DETAIL_LOCAL, false),
    timeoutMs: OPENCLAW_TIMEOUT_MS,
    sessionPrefix: 'detail',
    ...overrides,
  };
}

function buildOpenClawCommand(agentId: string, prompt: string, options?: OpenClawCallOptions): { args: string[]; timeoutMs: number } {
  const timeoutMs = options?.timeoutMs ?? OPENCLAW_TIMEOUT_MS;
  const sessionPrefix = options?.sessionPrefix || 'openclaw';
  const sessionId = `${sessionPrefix}-${Date.now()}-${randomUUID()}`;
  const args = ['agent'];

  if (options?.useLocal) {
    args.push('--local');
  }

  args.push(
    '--agent',
    agentId,
    '--session-id',
    sessionId,
    '--message',
    prompt,
    '--thinking',
    'off',
    '--json',
    '--timeout',
    String(Math.ceil(timeoutMs / 1000))
  );

  return { args, timeoutMs };
}

async function runOpenClawInLane<T>(laneKey: string, task: () => Promise<T>): Promise<T> {
  const previous = openClawLaneLocks.get(laneKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  openClawLaneLocks.set(laneKey, current);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
    if (openClawLaneLocks.get(laneKey) === current) {
      openClawLaneLocks.delete(laneKey);
    }
  }
}

async function runOpenClawAgent(executable: string, agentId: string, prompt: string, options?: OpenClawCallOptions): Promise<string> {
  const command = buildOpenClawCommand(agentId, prompt, options);
  const laneKey = `openclaw:${options?.useLocal ? 'local' : 'remote'}:${agentId}`;
  const { stdout, stderr } = await runOpenClawInLane(laneKey, () => execFileAsync(executable, command.args, {
    timeout: command.timeoutMs,
    maxBuffer: 1024 * 1024
  }));

  return (stdout || stderr || '').trim();
}

async function callOpenClaw(messages: Message[], options?: OpenClawCallOptions): Promise<string> {
  const resolvedOptions = getOpenClawAnalysisOptions(options);
  const configuredAgentId = resolvedOptions.agentId || OPENCLAW_ANALYSIS_AGENT_ID;
  const executable = process.env.OPENCLAW_BIN || 'openclaw';
  const prompt = messages.map(message => `[${message.role}]\n${message.content}`).join('\n\n');

  let output = '';
  try {
    output = await runOpenClawAgent(executable, configuredAgentId, prompt, resolvedOptions);
  } catch (error) {
    if (!shouldRetryWithFallbackAgent(error, configuredAgentId)) {
      throw error;
    }
    console.warn(`OpenClaw agent "${configuredAgentId}" not found, retrying with "${OPENCLAW_FALLBACK_AGENT_ID}"`);
    output = await runOpenClawAgent(executable, OPENCLAW_FALLBACK_AGENT_ID, prompt, {
      ...resolvedOptions,
      agentId: OPENCLAW_FALLBACK_AGENT_ID,
    });
  }

  if (!output) {
    throw new Error('OpenClaw returned empty output');
  }

  const parsed = extractEmbeddedJson(output);
  if (parsed && typeof parsed === 'object') {
    const parsedRecord = parsed as Record<string, unknown>;
    const resultPayloadText = pickPayloadText(parsedRecord.result);
    if (resultPayloadText) return resultPayloadText;

    const directPayloadText = pickPayloadText(parsedRecord);
    if (directPayloadText) return directPayloadText;

    if (parsedRecord.result || parsedRecord.status) {
      throw new Error('OpenClaw returned no text payload');
    }
    if (parsedRecord.reply) return typeof parsedRecord.reply === 'string' ? parsedRecord.reply : JSON.stringify(parsedRecord.reply);
    if (parsedRecord.message) return typeof parsedRecord.message === 'string' ? parsedRecord.message : JSON.stringify(parsedRecord.message);
    if (parsedRecord.content) return typeof parsedRecord.content === 'string' ? parsedRecord.content : JSON.stringify(parsedRecord.content);
    return JSON.stringify(parsed);
  }

  if (typeof parsed === 'string') {
    return parsed;
  }

  return output;
}

export async function debugStructuredText(messages: Message[], options?: StructuredGenerationOptions): Promise<string> {
  return generateStructuredText(messages, options);
}

export async function generateStructuredText(messages: Message[], options?: StructuredGenerationOptions): Promise<string> {
  const maxTokens = options?.maxTokens ?? 500;
  const temperature = options?.temperature ?? 0.2;

  if (getAIProvider() === 'openclaw') {
    try {
      return await callOpenClaw(messages, options?.openclaw);
    } catch (error) {
      if (!hasUsableOpenRouterKey()) {
        throw error;
      }
      console.warn(`OpenClaw unavailable, falling back to OpenRouter: ${error instanceof Error ? error.message : String(error)}`);
      return callOpenRouter(messages, maxTokens, temperature);
    }
  }

  if (!hasUsableOpenRouterKey()) {
    throw new Error('No AI provider configured');
  }

  return callOpenRouter(messages, maxTokens, temperature);
}

export async function generateStructuredJson<T>(messages: Message[], options?: StructuredGenerationOptions): Promise<T> {
  const text = await generateStructuredText(messages, options);
  return JSON.parse(extractJsonPayload(text)) as T;
}
