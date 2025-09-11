import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../shared/schema';

// Create postgres client
const connectionString = process.env.DATABASE_URL || "postgresql://localhost:5432/mastra";
const sql = postgres(connectionString);

// Create drizzle instance with schema
export const db = drizzle(sql, { schema });