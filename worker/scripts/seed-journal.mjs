#!/usr/bin/env node
/**
 * Copies the website journal articles from prisma/seed-data.json into D1 so
 * they appear under Website → Journal in the admin.
 *
 *   node scripts/seed-journal.mjs [--local] [--file ../../prisma/seed-data.json] [--dry-run]
 *
 * Uses INSERT OR IGNORE keyed on the slug: an article already edited in the
 * admin is never overwritten.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeFile, query, sqlString, target } from "./d1.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const where = target();
const dryRun = process.argv.includes("--dry-run");
const source = resolve(arg("file", fileURLToPath(new URL("../../prisma/seed-data.json", import.meta.url))));

const data = JSON.parse(readFileSync(source, "utf8"));
const posts = data.blog?.posts;
if (!Array.isArray(posts) || !posts.length) {
  console.error(`No blog.posts found in ${source}.`);
  process.exit(1);
}

const categories = query(`SELECT id, slug FROM blog_categories WHERE is_active = 1`, where);
const categoryBySlug = new Map(categories.map((row) => [row.slug, row.id]));
if (!categoryBySlug.size) {
  console.error("No blog categories in D1. Apply migration 0008 first.");
  process.exit(1);
}

function publishedAt(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return new Date(value).toISOString();
}

function normalizeBlocks(blocks) {
  return (blocks ?? []).map((block) => {
    if (block.type === "list") return { type: "list", items: block.items ?? [] };
    if (block.type === "quote") {
      return {
        type: "quote",
        text: block.text ?? "",
        ...(block.attribution ? { attribution: block.attribution } : {}),
      };
    }
    if (block.type === "image") {
      return {
        type: "image",
        url: block.url,
        alt: block.alt ?? "",
        ...(block.caption ? { caption: block.caption } : {}),
      };
    }
    if (block.type === "productLink" || block.type === "collectionLink") {
      return { type: block.type, slug: block.slug, label: block.label ?? "" };
    }
    return { type: block.type, text: block.text ?? "" };
  });
}

const statements = [];
const skipped = [];

for (const post of posts) {
  const categoryId = categoryBySlug.get(post.category);
  if (!categoryId) {
    skipped.push(`${post.slug} (unknown category ${post.category})`);
    continue;
  }
  const coverUrl = post.cover?.url ?? null;
  const coverAlt = post.cover?.alt ?? null;
  const faqs = (post.faqs ?? []).map((faq) => ({ question: faq.question, answer: faq.answer }));
  statements.push(`INSERT OR IGNORE INTO blog_posts (
  id, slug, title, excerpt, category_id, author_name, cover_url, cover_alt,
  blocks_json, faqs_json, reading_minutes, status, published_at, scheduled_at
) VALUES (${[
    sqlString(`post-${post.slug}`),
    sqlString(post.slug),
    sqlString(post.title),
    sqlString(post.excerpt),
    sqlString(categoryId),
    sqlString(post.author || "Pashmore Editorial"),
    sqlString(coverUrl),
    sqlString(coverAlt),
    sqlString(JSON.stringify(normalizeBlocks(post.blocks))),
    sqlString(JSON.stringify(faqs)),
    Number(post.readingMinutes) || 5,
    "'PUBLISHED'",
    sqlString(publishedAt(post.publishedAt)),
    "NULL",
  ].join(", ")});`);
}

console.log(`Found ${posts.length} journal articles in ${source}.`);
if (skipped.length) console.warn(`Skipped: ${skipped.join(", ")}`);
if (dryRun) {
  console.log(statements.join("\n\n"));
  process.exit(0);
}

if (!statements.length) {
  console.error("Nothing to insert.");
  process.exit(1);
}

executeFile(statements.join("\n"), where);
const rows = query(
  `SELECT p.slug, p.title, p.status, c.name AS category, p.published_at
     FROM blog_posts p JOIN blog_categories c ON c.id = p.category_id
    ORDER BY p.published_at DESC`,
  where,
);
console.table(rows);
