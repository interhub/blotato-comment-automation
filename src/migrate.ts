import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigrations } from "graphile-worker";
import { createPool, withTransaction, type Db } from "./db.js";
import { loadConfig } from "./config.js";
import { silentGraphileLogger } from "./logger.js";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(pool: Db): Promise<string[]> {
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await pool.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(migrationsDir + file, "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    newlyApplied.push(file);
  }
  await runMigrations({ pgPool: pool, logger: silentGraphileLogger });
  return newlyApplied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(loadConfig().databaseUrl);
  migrate(pool)
    .then((files) => console.log(files.length ? `applied: ${files.join(", ")}` : "schema up to date"))
    .finally(() => pool.end());
}
