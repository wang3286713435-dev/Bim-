import { Router } from 'express';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  getAuthConfig,
  getSessionFromRequest,
  verifyCredentials
} from '../services/auth.js';

const router = Router();

router.get('/session', async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({
      authenticated: false,
      username: null
    });
  }

  res.json({
    authenticated: true,
    username: session.username,
    expiresAt: session.expiresAt
  });
});

router.post('/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: '用户名或密码错误', code: 'AUTH_INVALID' });
  }

  const { cookie, session } = buildSessionCookie(username);
  res.setHeader('Set-Cookie', cookie);
  res.json({
    authenticated: true,
    username: session.username,
    expiresAt: session.expiresAt,
    sessionTtlHours: getAuthConfig().sessionTtlHours
  });
});

router.post('/logout', async (_req, res) => {
  res.setHeader('Set-Cookie', buildClearedSessionCookie());
  res.json({ success: true });
});

export default router;
