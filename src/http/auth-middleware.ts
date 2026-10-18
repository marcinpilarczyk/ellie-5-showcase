import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

export interface AuthOptions {
  /**
   * True when the request arrived on the private listener (ELLIE_PRIVATE_PORT, bound to
   * 127.0.0.1 and exposed only through `tailscale serve`). Decided by the socket, never by
   * headers: X-Forwarded-*, Host and Tailscale-* headers can all be forged through a public proxy.
   */
  isTrustedListener?: (req: Request) => boolean;
}

function tokensMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createAuthMiddleware(expectedToken: string, options: AuthOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Exempt paths
    const path = req.path.toLowerCase();
    if (
      path === '/api/health' ||
      path === '/health' ||
      path.startsWith('/api/slack/') ||
      path.startsWith('/api/integrations/google/callback') ||
      path.startsWith('/api/auth/google/callback')
    ) {
      return next();
    }

    if (options.isTrustedListener?.(req)) {
      return next();
    }

    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.query.token && typeof req.query.token === 'string') {
      token = req.query.token.trim();
    } else if (req.headers.cookie) {
      const match = req.headers.cookie.match(/ellie_token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1].trim());
    }

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

    if (!tokensMatch(token, expectedToken)) {
      if (req.accepts('html') && !req.path.startsWith('/api/')) {
        res.status(401).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Ellie - sign in</title>
          <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:#f8fafc;margin:0;}
          .card{background:#1e293b;padding:2rem;border-radius:8px;box-shadow:0 4px 6px -1px rgb(0 0 0/0.1);text-align:center;}
          input{padding:0.5rem 1rem;border-radius:4px;border:1px solid #475569;background:#0f172a;color:#fff;margin-right:0.5rem;}
          button{padding:0.5rem 1rem;border-radius:4px;border:none;background:#3b82f6;color:#fff;cursor:pointer;}
          </style></head>
          <body>
          <div class="card">
            <h2>Ellie</h2>
            <p>Please enter your Control Plane Token to open the control page.</p>
            <form method="GET" action="${escapeHtml(req.path)}">
              <input type="password" name="token" placeholder="Control Plane Token" required />
              <button type="submit">Access</button>
            </form>
          </div>
          </body>
          </html>
        `);
        return;
      }
      res.status(401).json({ error: 'Unauthorized: Valid control plane token required' });
      return;
    }

    // Valid token from the login form: keep it in a cookie and drop it from the URL
    if (req.query.token && req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) {
      res.cookie('ellie_token', token!, { httpOnly: true, sameSite: 'lax', secure: req.secure });
      const rest = new URLSearchParams(req.query as Record<string, string>);
      rest.delete('token');
      const qs = rest.toString();
      res.redirect(qs ? `${req.path}?${qs}` : req.path);
      return;
    }

    next();
  };
}

/** Production refuses to start with a guessable or missing control-plane token. */
export function resolveControlPlaneToken(): string {
  const token = process.env.ELLIE_CONTROL_PLANE_TOKEN?.trim();
  if (token && token !== 'your-random-secret-token-here') return token;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ELLIE_CONTROL_PLANE_TOKEN must be set in production.');
  }
  return 'test-token-12345';
}
