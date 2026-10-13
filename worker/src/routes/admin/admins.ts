import { Hono } from "hono";
import { z } from "zod";
import { ADMIN_ROLE_KEYS, permissionCatalogue, roleBySlug, ROLES, type AdminRoleKey } from "../../auth/permissions";
import { revokeAllStatement } from "../../auth/sessions";
import { auditStatement } from "../../lib/audit";
import { hashPassword } from "../../lib/crypto";
import { badRequest, conflict, isUniqueViolation, notFound, notImplemented } from "../../lib/errors";
import { ok, paginated } from "../../lib/http";
import { newId, parseJson, toIso } from "../../lib/util";
import { body, email, password, phone, query } from "../../lib/validation";
import { can, currentUser } from "../../middleware/auth";
import type { AppEnv } from "../../types";

interface AdminRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  active: number;
  admin_role: AdminRoleKey;
  last_login_at: string | null;
  created_at: string;
}

function adminDto(row: AdminRow) {
  const role = ROLES[row.admin_role];
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    isActive: row.active === 1,
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at),
    role: { id: role.slug, name: role.name, slug: role.slug },
  };
}

const adminPassword = password.min(12, "Admin passwords need at least 12 characters.");
const roleId = z.string().refine((value) => Boolean(roleBySlug(value)), "Unknown role.");

/** Matches only when the change would still leave another active Super Admin. */
const KEEPS_A_SUPER_ADMIN = `(admin_role <> 'SUPER_ADMIN' OR (SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND admin_role = 'SUPER_ADMIN' AND active = 1 AND deleted_at IS NULL AND id <> ?) > 0)`;

async function loadAdmin(db: D1Database, id: string): Promise<AdminRow> {
  const row = await db
    .prepare(`SELECT id, email, name, phone, active, admin_role, last_login_at, created_at FROM users WHERE id = ? AND role = 'ADMIN' AND deleted_at IS NULL`)
    .bind(id)
    .first<AdminRow>();
  if (!row || !ADMIN_ROLE_KEYS.includes(row.admin_role)) throw notFound("Admin");
  return row;
}

export const adminUserRoutes = new Hono<AppEnv>();

adminUserRoutes.get("/", can("admins.view"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, name, phone, active, admin_role, last_login_at, created_at FROM users
      WHERE role = 'ADMIN' AND deleted_at IS NULL AND admin_role IS NOT NULL ORDER BY created_at`,
  ).all<AdminRow>();
  return ok(c, results.filter((row) => ADMIN_ROLE_KEYS.includes(row.admin_role)).map(adminDto));
});

adminUserRoutes.post("/", can("admins.create"), async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(120), email, password: adminPassword, roleId, phone: phone.optional() }));
  const role = roleBySlug(input.roleId)!;
  const db = c.env.DB;
  const existing = await db.prepare(`SELECT id, role, deleted_at FROM users WHERE email = ?`).bind(input.email).first<{ id: string; role: string; deleted_at: string | null }>();
  const { hash, salt } = await hashPassword(input.password);
  let id: string;
  if (existing) {
    // A removed admin can be re-invited; a live account (customer or admin) cannot be converted.
    if (existing.role !== "ADMIN" || !existing.deleted_at) throw conflict("EMAIL_TAKEN", "An account with this email already exists.");
    id = existing.id;
    await db.batch([
      db
        .prepare(
          `UPDATE users SET name = ?, phone = ?, admin_role = ?, password_hash = ?, password_salt = ?, active = 1, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted_at IS NOT NULL`,
        )
        .bind(input.name, input.phone ?? null, role.key, hash, salt, id),
      auditStatement(c, { action: "admin.restore", entityType: "admin", targetId: id, metadata: { email: input.email, role: role.key } }),
    ]);
  } else {
    id = newId();
    try {
      await db.batch([
        db
          .prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, role, admin_role, phone, active) VALUES (?, ?, ?, ?, ?, 'ADMIN', ?, ?, 1)`)
          .bind(id, input.email, input.name, hash, salt, role.key, input.phone ?? null),
        auditStatement(c, { action: "admin.create", entityType: "admin", targetId: id, metadata: { email: input.email, role: role.key } }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("EMAIL_TAKEN", "An account with this email already exists.");
      throw error;
    }
  }
  return ok(c, adminDto(await loadAdmin(db, id)), undefined, 201);
});

adminUserRoutes.patch("/:id", can("admins.update"), async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: phone.nullable().optional(),
      roleId: roleId.optional(),
      isActive: z.boolean().optional(),
      password: adminPassword.optional(),
    }),
  );
  const auth = currentUser(c);
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await loadAdmin(db, id);
  const role = input.roleId ? roleBySlug(input.roleId)!.key : row.admin_role;
  const active = input.isActive === undefined ? row.active : input.isActive ? 1 : 0;
  if (id === auth.userId && (role !== row.admin_role || active !== 1)) {
    throw badRequest("You cannot change your own role or deactivate yourself.");
  }
  const demotesSuperAdmin = row.admin_role === "SUPER_ADMIN" && (role !== "SUPER_ADMIN" || active !== 1);
  const credentials = input.password ? await hashPassword(input.password) : null;
  const statements = [
    db
      .prepare(
        `UPDATE users SET name = ?, phone = ?, admin_role = ?, active = ?, updated_at = CURRENT_TIMESTAMP,
                password_hash = COALESCE(?, password_hash), password_salt = COALESCE(?, password_salt)
          WHERE id = ? AND role = 'ADMIN' AND deleted_at IS NULL ${demotesSuperAdmin ? `AND ${KEEPS_A_SUPER_ADMIN}` : ""}`,
      )
      .bind(
        input.name ?? row.name,
        input.phone === undefined ? row.phone : input.phone,
        role,
        active,
        credentials?.hash ?? null,
        credentials?.salt ?? null,
        id,
        ...(demotesSuperAdmin ? [id] : []),
      ),
  ];
  if (active !== 1 || role !== row.admin_role || credentials) statements.push(revokeAllStatement(db, id));
  statements.push(
    auditStatement(c, {
      action: "admin.update",
      entityType: "admin",
      targetId: id,
      metadata: { name: input.name, role: role !== row.admin_role ? { from: row.admin_role, to: role } : undefined, isActive: input.isActive, passwordReset: Boolean(credentials) },
    }),
  );
  const [update] = await db.batch(statements);
  if ((update?.meta.changes ?? 0) === 0) throw conflict("LAST_SUPER_ADMIN", "At least one active Super Admin must remain.");
  return ok(c, adminDto(await loadAdmin(db, id)));
});

adminUserRoutes.delete("/:id", can("admins.delete"), async (c) => {
  const auth = currentUser(c);
  const db = c.env.DB;
  const id = c.req.param("id");
  if (id === auth.userId) throw badRequest("You cannot remove your own account.");
  await loadAdmin(db, id);
  const [update] = await db.batch([
    db
      .prepare(`UPDATE users SET active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role = 'ADMIN' AND deleted_at IS NULL AND ${KEEPS_A_SUPER_ADMIN}`)
      .bind(id, id),
    revokeAllStatement(db, id),
    auditStatement(c, { action: "admin.delete", entityType: "admin", targetId: id }),
  ]);
  if ((update?.meta.changes ?? 0) === 0) throw conflict("LAST_SUPER_ADMIN", "At least one active Super Admin must remain.");
  return ok(c, { id, deleted: true });
});

export const adminRoleRoutes = new Hono<AppEnv>();

adminRoleRoutes.get("/", can("roles.view"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT admin_role, COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND deleted_at IS NULL GROUP BY admin_role`,
  ).all<{ admin_role: string; n: number }>();
  const counts = new Map(results.map((row) => [row.admin_role, row.n]));
  return ok(c, {
    roles: Object.values(ROLES).map((role) => ({
      id: role.slug,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: true,
      editable: false,
      adminCount: counts.get(role.key) ?? 0,
      permissions: role.permissions,
    })),
    allPermissions: permissionCatalogue(),
  });
});

adminRoleRoutes.put("/:id/permissions", can("roles.view"), () => {
  throw notImplemented("Roles are fixed in this version. Assign a different role to change what an admin can do.");
});

export const adminAuditRoutes = new Hono<AppEnv>();

adminAuditRoutes.get("/", can("audit.view"), async (c) => {
  const input = query(
    c,
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      entityType: z.string().trim().max(40).optional(),
      action: z.string().trim().max(80).optional(),
      userId: z.string().max(64).optional(),
    }),
  );
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.entityType) {
    where.push("LOWER(a.entity_type) = LOWER(?)");
    binds.push(input.entityType);
  }
  if (input.action) {
    where.push("a.action LIKE ? ESCAPE '\\'");
    binds.push(`${input.action.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
  }
  if (input.userId) {
    where.push("a.user_id = ?");
    binds.push(input.userId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT a.*, u.name AS user_name, u.email AS user_email, u.role AS user_role FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
         ${clause} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM audit_events a ${clause}`).bind(...binds),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as Array<Record<string, string | null>>).map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type ?? "",
      entityId: row.target_id,
      ip: row.ip,
      userAgent: row.user_agent,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: toIso(row.created_at),
      adminUser: row.user_id && row.user_role === "ADMIN" ? { id: row.user_id, name: row.user_name ?? "", email: row.user_email ?? "" } : null,
      actor: row.user_id ? { id: row.user_id, name: row.user_name ?? "", email: row.user_email ?? "", role: row.user_role } : null,
    })),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});