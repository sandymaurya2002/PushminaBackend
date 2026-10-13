import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function pagination(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

export function ok<T>(c: Context, data: T, meta?: Record<string, unknown>, status: ContentfulStatusCode = 200) {
  return c.json({ success: true as const, data, ...(meta ? { meta } : {}) }, status);
}

export function created<T>(c: Context, data: T, meta?: Record<string, unknown>) {
  return ok(c, data, meta, 201);
}

export function paginated<T>(c: Context, items: T[], total: number, page: number, limit: number, extra?: Record<string, unknown>) {
  return ok(c, items, { ...pagination(total, page, limit), ...extra });
}

export function noContent(c: Context) {
  return c.body(null, 204);
}

export function csv(c: Context, filename: string, rows: Array<Record<string, unknown>>, columns: string[]) {
  const escape = (value: unknown): string => {
    let text = value === null || value === undefined ? "" : String(value);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n");
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
    "Cache-Control": "no-store",
  });
}
