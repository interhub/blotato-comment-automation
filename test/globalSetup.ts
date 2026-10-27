import pg from "pg";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { TEST_DATABASE_URL } from "./db.js";

/** Creates the test database if needed and rebuilds its schema from the migrations. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: new URL("/postgres", url).toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [database]);
    if (!rowCount) await admin.query(`create database "${database}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query("drop schema if exists graphile_worker cascade; drop schema public cascade; create schema public;");
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
