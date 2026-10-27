import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction, type Db } from "../db.js";
import { definitionSchema } from "../domain/definition.js";
import { PLATFORMS } from "../platform/types.js";
import { HttpError, idOr404, parseOr400 } from "./http.js";

const createSchema = z.object({
  platform: z.enum(PLATFORMS),
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  status: z.enum(["active", "paused"]).default("active"),
  definition: definitionSchema,
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "paused"]).optional(),
  definition: definitionSchema,
});

export async function automationRoutes(app: FastifyInstance, opts: { pool: Db }) {
  const { pool } = opts;

  app.post("/automations", async (req, reply) => {
    const body = parseOr400(createSchema, req.body);
    const id = await withTransaction(pool, async (client) => {
      const { rows: accounts } = await client.query<{ id: string }>(
        `insert into social_accounts (platform, external_account_id) values ($1, $2)
         on conflict (platform, external_account_id) do update set platform = excluded.platform
         returning id`,
        [body.platform, body.accountId],
      );
      const { rows } = await client.query<{ id: string }>(
        "insert into automations (account_id, name, status) values ($1, $2, $3) returning id",
        [accounts[0]!.id, body.name, body.status],
      );
      const automationId = rows[0]!.id;
      await client.query("insert into automation_versions (automation_id, version, definition) values ($1, 1, $2)", [
        automationId,
        body.definition,
      ]);
      return automationId;
    });
    return reply.code(201).send(await getAutomation(pool, id));
  });

  // Editing never mutates a version: running conversations stay pinned to the steps they started with.
  app.put<{ Params: { id: string } }>("/automations/:id", async (req) => {
    const id = idOr404(req.params.id);
    const body = parseOr400(updateSchema, req.body);
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ current_version: number }>(
        `update automations
         set current_version = current_version + 1,
             name = coalesce($2, name),
             status = coalesce($3, status),
             updated_at = now()
         where id = $1
         returning current_version`,
        [id, body.name ?? null, body.status ?? null],
      );
      if (!rows[0]) throw new HttpError(404, "not found");
      await client.query("insert into automation_versions (automation_id, version, definition) values ($1, $2, $3)", [
        id,
        rows[0].current_version,
        body.definition,
      ]);
    });
    return getAutomation(pool, id);
  });

  app.get<{ Params: { id: string } }>("/automations/:id", async (req) => {
    const automation = await getAutomation(pool, idOr404(req.params.id));
    if (!automation) throw new HttpError(404, "not found");
    return automation;
  });
}

async function getAutomation(pool: Db, id: string) {
  const { rows } = await pool.query(
    `select a.id, s.platform, s.external_account_id as "accountId", a.name, a.status,
            a.current_version as "version", v.definition, a.created_at as "createdAt", a.updated_at as "updatedAt",
            (select coalesce(json_agg(r order by r."createdAt" desc), '[]')
             from (select id, status, outcome, contact_id as "contactId", automation_version as "version",
                          created_at as "createdAt"
                   from runs where automation_id = a.id order by created_at desc limit 20) r) as "recentRuns"
     from automations a
     join social_accounts s on s.id = a.account_id
     join automation_versions v on v.automation_id = a.id and v.version = a.current_version
     where a.id = $1`,
    [id],
  );
  return rows[0];
}
