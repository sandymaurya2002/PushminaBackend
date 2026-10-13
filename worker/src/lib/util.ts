export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** D1 CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC; normalise to ISO-8601. */
export function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}

export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function toRupees(paise: number | null | undefined): number {
  return Math.round(Number(paise ?? 0)) / 100;
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/** Escapes LIKE wildcards; pair with `ESCAPE '\\'`. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
