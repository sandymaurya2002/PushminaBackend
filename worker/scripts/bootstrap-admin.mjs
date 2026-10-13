#!/usr/bin/env node
/**
 * Creates the first Super Admin directly in D1.
 *
 *   node scripts/bootstrap-admin.mjs --email owner@pashmore.com --name "Store Owner" [--local]
 *
 * The password comes from ADMIN_BOOTSTRAP_PASSWORD, or a random one is generated
 * and printed once. It is never written to disk; only the PBKDF2 hash reaches
 * the database (via a temporary SQL file that is deleted immediately).
 * Refuses to touch an existing account.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/lib/crypto.ts";
import { executeFile, query, sqlString, target } from "./d1.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const email = arg("email")?.trim().toLowerCase();
const name = arg("name")?.trim() || "Store Owner";
const role = arg("role")?.trim().toUpperCase() || "SUPER_ADMIN";
const where = target();

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/bootstrap-admin.mjs --email owner@example.com --name "Store Owner" [--role SUPER_ADMIN] [--local]');
  process.exit(1);
}
if (!["SUPER_ADMIN", "ADMIN", "MANAGER", "EDITOR", "SUPPORT"].includes(role)) {
  console.error(`Unknown role ${role}.`);
  process.exit(1);
}

let password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
const generated = !password;
if (!password) password = `${randomBytes(18).toString("base64url")}-${Math.floor(Math.random() * 90 + 10)}`;
if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
  console.error("ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters with a letter and a number.");
  process.exit(1);
}

const existing = query(`SELECT id, role FROM users WHERE email = ${sqlString(email)}`, where);
if (existing.length) {
  console.error(`An account for ${email} already exists (role ${existing[0].role}). Nothing was changed.`);
  process.exit(1);
}

const { hash, salt } = await hashPassword(password);
const id = randomUUID().replace(/-/g, "");
executeFile(
  `INSERT INTO users (id, email, name, password_hash, password_salt, role, admin_role, active)
   VALUES (${sqlString(id)}, ${sqlString(email)}, ${sqlString(name)}, ${sqlString(hash)}, ${sqlString(salt)}, 'ADMIN', ${sqlString(role)}, 1);
   INSERT INTO audit_events (id, user_id, action, entity_type, target_id, metadata_json)
   VALUES (${sqlString(randomUUID().replace(/-/g, ""))}, NULL, 'admin.bootstrap', 'admin', ${sqlString(id)}, ${sqlString(JSON.stringify({ email, role }))});`,
  where,
);

console.log(`Created ${role} ${email} in the ${where === "--remote" ? "live" : "local"} database.`);
if (generated) {
  console.log("\nGenerated password (shown once, store it in a password manager, then change it after first sign-in):");
  console.log(`  ${password}\n`);
}
