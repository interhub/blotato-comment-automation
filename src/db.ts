import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(
  connectionString: string,
  onIdleError: (error: Error) => void = (error) => console.error("idle postgres client error", error),
): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 20 });
  // A client can lose its connection (database restart); without listeners that crashes the process.
  pool.on("error", onIdleError);
  pool.on("connect", (client) => client.on("error", onIdleError));
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Serializes every decision about one person on one account (run creation, routing, finishing). */
export async function lockContact(client: pg.PoolClient, accountId: string, contactId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:${contactId}`]);
}
