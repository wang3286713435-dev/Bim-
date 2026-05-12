import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type AuthSession = {
  username: string;
  expiresAt: string;
};

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'bim_tender_session';
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '88888888';
const AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || 'bim-tender-session-secret';
const AUTH_SESSION_TTL_HOURS = Math.max(
  1,
  Number.parseInt(process.env.AUTH_SESSION_TTL_HOURS || '168', 10) || 168
);
const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE === 'true';

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(value: string): string {
  return crypto.createHmac('sha256', AUTH_SESSION_SECRET).update(value).digest('hex');
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce<Record<string, string>>((acc, item) => {
    const [rawKey, ...rest] = item.trim().split('=');
    if (!rawKey || rest.length === 0) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (AUTH_COOKIE_SECURE) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function buildSessionCookie(username: string): { cookie: string; session: AuthSession } {
  const expiresAtDate = new Date(Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000);
  const session: AuthSession = {
    username,
    expiresAt: expiresAtDate.toISOString()
  };
  const payload = toBase64Url(JSON.stringify(session));
  const token = `${payload}.${sign(payload)}`;
  return {
    cookie: serializeCookie(token, AUTH_SESSION_TTL_HOURS * 60 * 60),
    session
  };
}

export function buildClearedSessionCookie(): string {
  return serializeCookie('', 0);
}

export function verifyCredentials(username: string, password: string): boolean {
  return username === AUTH_USERNAME && password === AUTH_PASSWORD;
}

export function getAuthConfig() {
  return {
    username: AUTH_USERNAME,
    sessionTtlHours: AUTH_SESSION_TTL_HOURS,
    cookieName: AUTH_COOKIE_NAME
  };
}

export function getSessionFromRequest(request: Pick<Request, 'headers'>): AuthSession | null {
  const cookies = parseCookieHeader(request.headers.cookie);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as AuthSession;
    if (!parsed.username || !parsed.expiresAt) return null;
    if (Number.isNaN(new Date(parsed.expiresAt).getTime())) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
    return;
  }

  (req as Request & { authSession?: AuthSession }).authSession = session;
  next();
}
