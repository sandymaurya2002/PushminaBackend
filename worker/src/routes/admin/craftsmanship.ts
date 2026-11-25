import type { Hono } from "hono";
import { z } from "zod";
import { auditStatement } from "../../lib/audit";
import { ok } from "../../lib/http";
import { newId } from "../../lib/util";
import { body } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const mediaUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/(media|images|videos)\/[^\s]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Choose an uploaded file or an https:// URL.");

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? null : value), schema.nullable().optional());

const stageSchema = z.object({
  step: z.string().trim().min(1).max(8),
  heading: z.string().trim().min(1, "A heading is required.").max(120),
  duration: z.string().trim().min(1, "A duration is required.").max(80),
  body: z.string().trim().min(1, "The stage needs a description.").max(2000),
  imageUrl: mediaUrl,
  imageAlt: optional(z.string().trim().max(200)),
});

const pageSchema = z.object({
  eyebrow: optional(z.string().trim().max(80)),
  heading: z.string().trim().min(1, "A heading is required.").max(180),
  intro: optional(z.string().trim().max(2000)),
  stages: z.array(stageSchema).min(1, "Add at least one stage.").max(8),
});

interface PageRow {
  id: string;
  eyebrow: string | null;
  heading: string | null;
  intro: string | null;
}

interface StageRow {
  id: string;
  step: string;
  heading: string;
  duration: string;
  body: string;
  image_url: string | null;
  image_alt: string | null;
  sort_order: number;
}

function stageDto(row: StageRow) {
  return {
    id: row.id,
    step: row.step,
    heading: row.heading,
    duration: row.duration,
    body: row.body,
    imageUrl: row.image_url,
    imageAlt: row.image_alt,
    sortOrder: row.sort_order,
  };
}

async function load(db: D1Database) {
  const [page, stages] = await db.batch([
    db.prepare(`SELECT * FROM craftsmanship_pages WHERE id = 'craftsmanship'`),
    db.prepare(`SELECT * FROM craftsmanship_stages ORDER BY sort_order, step`),
  ]);
  const row = (page?.results?.[0] ?? null) as PageRow | null;
  return {
    eyebrow: row?.eyebrow ?? "",
    heading: row?.heading ?? "",
    intro: row?.intro ?? "",
    stages: ((stages?.results ?? []) as unknown as StageRow[]).map(stageDto),
  };
}

/** Registered on the admin content router: Website → Craftsmanship. */
export function mountCraftsmanship(routes: Hono<AppEnv>) {
  routes.get("/craftsmanship", can("content.view"), async (c) => ok(c, await load(c.env.DB)));

  routes.put("/craftsmanship", can("content.update"), async (c) => {
    const input = await body(c, pageSchema);
    const userId = c.get("auth")!.userId;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO craftsmanship_pages (id, eyebrow, heading, intro, updated_at) VALUES ('craftsmanship', ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET eyebrow = excluded.eyebrow, heading = excluded.heading, intro = excluded.intro, updated_at = CURRENT_TIMESTAMP`,
      ).bind(input.eyebrow ?? null, input.heading, input.intro ?? null),
      c.env.DB.prepare(`DELETE FROM craftsmanship_stages`),
      ...input.stages.map((stage, index) =>
        c.env.DB.prepare(
          `INSERT INTO craftsmanship_stages (id, step, heading, duration, body, image_url, image_alt, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(newId(), stage.step, stage.heading, stage.duration, stage.body, stage.imageUrl ?? null, stage.imageAlt ?? stage.heading, (index + 1) * 10),
      ),
      auditStatement(c, {
        action: "craftsmanship.update",
        entityType: "craftsmanship",
        targetId: "craftsmanship",
        metadata: { stages: input.stages.length, updatedBy: userId },
      }),
    ]);
    return ok(c, await load(c.env.DB));
  });
}
