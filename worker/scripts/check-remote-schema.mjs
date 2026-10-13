#!/usr/bin/env node
/**
 * Read-only pre-flight check before `wrangler d1 migrations apply DB --remote`.
 *
 * - Lists which migrations the database has already recorded.
 * - Compares live tables with the 0001 baseline (drift would mean the baseline is wrong).
 * - For pending migrations, flags every `ALTER TABLE ... ADD COLUMN` whose column already
 *   exists, which would make the migration fail half-way.
 *
 * Usage: node scripts/check-remote-schema.mjs [--local]
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, target } from "./d1.mjs";

const where = target();
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const files = readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();

const tables = query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).map((row) => row.name);
const columns = new Map();
if (tables.length) {
  for (const row of query(`SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE '_cf_%'`)) {
    if (!columns.has(row.tbl)) columns.set(row.tbl, new Set());
    columns.get(row.tbl).add(row.col);
  }
}
const applied = new Set(tables.includes("d1_migrations") ? query(`SELECT name FROM d1_migrations`).map((row) => row.name) : []);

const problems = [];
const notes = [];

/* Baseline drift */
const baseline = readFileSync(new URL("../migrations/0001_baseline.sql", import.meta.url), "utf8");
for (const match of baseline.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);\s*$/gm)) {
  const [, table, body] = match;
  if (!columns.has(table)) {
    notes.push(`baseline table ${table} does not exist yet (0001 will create it)`);
    continue;
  }
  const expected = body
    .split(/,(?![^()]*\))/)
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((name) => name && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(name));
  const missing = expected.filter((name) => !columns.get(table).has(name));
  if (missing.length) problems.push(`live table ${table} is missing baseline columns: ${missing.join(", ")}`);
}

/* Pending ALTERs that would collide */
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
  for (const match of sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) {
    const [, table, column] = match;
    if (columns.get(table)?.has(column)) problems.push(`${file}: ${table}.${column} already exists; the migration would fail`);
  }
}

console.log(`Target: ${where === "--remote" ? "remote (live) database" : "local database"}`);
console.log(`Tables: ${tables.length ? tables.join(", ") : "(none)"}`);
console.log(`Migrations recorded: ${applied.size ? [...applied].join(", ") : "(none)"}`);
console.log(`Pending migrations: ${files.filter((file) => !applied.has(file)).join(", ") || "(none)"}`);
for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  console.error("\nDo not apply migrations until these are resolved.");
  process.exit(1);
}
console.log("\nOK: pending migrations can be applied without colliding with the live schema.");
