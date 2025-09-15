import { createHash, randomBytes } from 'crypto';

// Admin credentials loaded from environment variables
const ADMIN_CREDENTIALS = {
  username: process.env.ADMIN_USERNAME || 'admin',
  passwordHash: process.env.ADMIN_PASSWORD_HASH || (() => {
    // Fallback: hash the password from env var if hash not provided
    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
      throw new Error('ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be set in environment variables');
    }
    return createHash('sha256').update(password).digest('hex');
  })()
};

// Store active sessions in memory (in production, use Redis or database)
const activeSessions = new Map<string, { userId: string; expiresAt: Date }>();

export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function validateCredentials(username: string, password: string): boolean {
  const passwordHash = hashPassword(password);
  return username === ADMIN_CREDENTIALS.username && 
         passwordHash === ADMIN_CREDENTIALS.passwordHash;
}

export function createSession(userId: string): string {
  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour session

  activeSessions.set(token, { userId, expiresAt });
  return token;
}

export function validateSession(token: string): boolean {
  const session = activeSessions.get(token);
  if (!session) return false;

  if (new Date() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }

  return true;
}

export function destroySession(token: string): void {
  activeSessions.delete(token);
}

export function requireAuth(req: any): boolean {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader) return false;

  const token = authHeader.replace('Bearer ', '');
  return validateSession(token);
}