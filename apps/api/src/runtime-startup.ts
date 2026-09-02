import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, databaseReady, type Database } from "@qintopia/db";
import { buildServer } from "./server.ts";

type DatabaseFactory = (url?: string) => Kysely<Database>;
type ReadinessCheck = (db: Kysely<Database>) => Promise<boolean>;
type ServerFactory = (db: Kysely<Database>) => Promise<FastifyInstance>;

export interface RuntimeApiStartupOptions {
  databaseUrl?: string;
  createDatabase?: DatabaseFactory;
  databaseReady?: ReadinessCheck;
  buildServer?: ServerFactory;
}

export interface RuntimeApiListenOptions extends RuntimeApiStartupOptions {
  host?: string;
  port?: number;
}

export interface RuntimeApi {
  app: FastifyInstance;
  db: Kysely<Database>;
}

export class RuntimeDatabaseNotReadyError extends Error {
  constructor() {
    super("Runtime database readiness validation failed; refusing to start API server");
    this.name = "RuntimeDatabaseNotReadyError";
  }
}

function startupDatabase(options: RuntimeApiStartupOptions): Kysely<Database> {
  const factory = options.createDatabase ?? createDatabase;
  return options.databaseUrl === undefined ? factory() : factory(options.databaseUrl);
}

export async function createRuntimeApi(options: RuntimeApiStartupOptions = {}): Promise<RuntimeApi> {
  const db = startupDatabase(options);
  const checkReady = options.databaseReady ?? databaseReady;
  const createServer = options.buildServer ?? buildServer;

  try {
    if (!await checkReady(db)) {
      throw new RuntimeDatabaseNotReadyError();
    }
    return {
      db,
      app: await createServer(db)
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

export async function listenRuntimeApi(options: RuntimeApiListenOptions = {}): Promise<RuntimeApi> {
  const runtime = await createRuntimeApi(options);
  try {
    await runtime.app.listen({
      host: options.host ?? "0.0.0.0",
      port: options.port ?? Number(process.env.PORT ?? 4100)
    });
    return runtime;
  } catch (error) {
    await runtime.app.close();
    throw error;
  }
}
