#!/usr/bin/env node
/**
 * Copies the storefront's built-in policy pages (shipping, returns, privacy,
 * terms) into D1 so they can be edited from the admin's Pages screen.
 *
 *   node scripts/seed-content.mjs [--local] [--policies ../../Pashmore/src/data/policies.ts] [--dry-run]
 *
 * Uses INSERT OR IGNORE keyed on the slug: a page that already exists (for
 * example one edited in the admin) is never overwritten. Needs Node 22.6+ to
 * import the TypeScript source directly.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeFile, query, sqlString, target } from "./d1.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const where = target();
const dryRun = process.argv.includes("--dry-run");
const source = resolve(arg("policies", "../../Pashmore/src/data/policies.ts"));

const { policies } = await import(pathToFileURL(source).href);
if (!Array.isArray(policies) || !policies.length) {
  console.error(`No policies exported from ${source}.`);
  process.exit(1);
}

const statements = policies.map((page) => {
  const sections = (page.sections ?? []).map((section) => ({ heading: section.heading, body: section.body ?? [], ...(section.list ? { list: section.list } : {}) }));
  const faqs = (page.faqs ?? []).map((faq) => ({ question: faq.question, answer: faq.answer }));
  return `INSERT OR IGNORE INTO content_pages (id, slug, title, eyebrow, intro, sections_json, faqs_json, updated_label, meta_title, meta_description, status, is_system)
VALUES (${[
    sqlString(`page-${page.slug}`),
    sqlString(page.slug),
    sqlString(page.title),
    sqlString(page.eyebrow ?? null),
    sqlString(page.intro ?? null),
    sqlString(JSON.stringify(sections)),
    sqlString(JSON.stringify(faqs)),
    sqlString(page.updated ?? null),
    sqlString(page.metaTitle ?? null),
    sqlString(page.metaDescription ?? null),
    "'PUBLISHED'",
    "1",
  ].join(", ")});`;
});

console.log(`Found ${policies.length} pages in ${source}: ${policies.map((page) => page.slug).join(", ")}`);
if (dryRun) {
  console.log(statements.join("\n\n"));
  process.exit(0);
}
executeFile(statements.join("\n"), where);
const rows = query(`SELECT slug, title, status, updated_at FROM content_pages ORDER BY slug`, where);
console.table(rows);
