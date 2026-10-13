import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");

export function target(argv = process.argv) {
  return argv.includes("--local") ? "--local" : "--remote";
}

/** Runs the project's wrangler through node directly, so arguments are never re-parsed by a shell. */
function wrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parse(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  return JSON.parse(stdout.slice(start).replace(/^\uFEFF/, ""));
}

/** Runs one read-only SQL statement and returns its rows. */
export function query(sql, where = target()) {
  const output = parse(wrangler(["d1", "execute", "DB", where, "--json", "--command", sql]));
  return output[0]?.results ?? [];
}

/** Runs SQL from a temporary file (avoids shell quoting), deleting the file afterwards. */
export function executeFile(sql, where = target()) {
  const dir = mkdtempSync(join(tmpdir(), "pashmore-d1-"));
  const file = join(dir, "statement.sql");
  try {
    writeFileSync(file, sql, { encoding: "utf8", mode: 0o600 });
    return parse(wrangler(["d1", "execute", "DB", where, "--json", "--yes", "--file", file]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}
