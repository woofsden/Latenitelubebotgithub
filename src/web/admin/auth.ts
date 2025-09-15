import { createHash, randomBytes } from 'crypto';

// Simple admin credentials - in production, use proper authentication
const ADMIN_CREDENTIALS = {
  username: 'admin',
  // Password: 'admin123' hashed with SHA-256
  passwordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'
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