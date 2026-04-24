import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenRouter } from '@openrouter/sdk';

const execFileAsync = promisify(execFile);

type Message = {
  role: 'system' | 'user';
  content: string;
};

const OPENCLAW_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_TIMEOUT_MS || '180000', 10);

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

async function callOpenClaw(messages: Message[]): Promise<string> {
  const agentId = process.env.OPENCLAW_AGENT_ID || 'bim-tender';
  const executable = process.env.OPENCLAW_BIN || 'openclaw';
  const prompt = messages.map(message => `[${message.role}]\n${message.content}`).join('\n\n');

  const { stdout, stderr } = await execFileAsync(
    executable,
    ['agent', '--agent', agentId, '--message', prompt, '--thinking', 'off', '--json', '--timeout', String(Math.ceil(OPENCLAW_TIMEOUT_MS / 1000))],
    {
      timeout: OPENCLAW_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    }
  );

  const output = (stdout || stderr || '').trim();
  if (!output) {
    throw new Error('OpenClaw returned empty output');
  }

  try {
    const parsed = JSON.parse(output);
    const payloadText = parsed?.result?.payloads?.[0]?.text;
    if (typeof payloadText === 'string' && payloadText.trim()) {
      return payloadText;
    }
    if (typeof parsed === 'string') return parsed;
    if (parsed.reply) return typeof parsed.reply === 'string' ? parsed.reply : JSON.stringify(parsed.reply);
    if (parsed.message) return typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message);
    if (parsed.content) return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
    return JSON.stringify(parsed);
  } catch {
    return output;
  }
}

export async function debugStructuredText(messages: Message[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
  return generateStructuredText(messages, options);
}

export async function generateStructuredText(messages: Message[], options?: { maxTokens?: number; temperature?: number }): Promise<string> {
  const maxTokens = options?.maxTokens ?? 500;
  const temperature = options?.temperature ?? 0.2;

  if (getAIProvider() === 'openclaw') {
    return callOpenClaw(messages);
  }

  if (!hasUsableOpenRouterKey()) {
    throw new Error('No AI provider configured');
  }

  return callOpenRouter(messages, maxTokens, temperature);
}

export async function generateStructuredJson<T>(messages: Message[], options?: { maxTokens?: number; temperature?: number }): Promise<T> {
  const text = await generateStructuredText(messages, options);
  return JSON.parse(extractJsonPayload(text)) as T;
}
