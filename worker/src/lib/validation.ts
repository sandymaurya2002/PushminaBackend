import type { Context } from "hono";
import { z } from "zod";
import { isIndia } from "../commerce/currency";
import { badRequest, validationError } from "./errors";

const MAX_JSON_BYTES = 256 * 1024;

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    details[key] ??= issue.message;
  }
  return details;
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(fieldErrors(result.error));
  return result.data;
}

export async function readJson(c: Context): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_JSON_BYTES) throw badRequest("Request body is too large.");
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw badRequest("Request body is too large.");
  if (!text.trim()) return {};
  const type = c.req.header("content-type") ?? "";
  if (!type.includes("application/json")) throw badRequest("Content-Type must be application/json.");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }
}

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return parse(schema, await readJson(c));
}

export function query<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parse(schema, c.req.query());
}

/** "a,b" or repeated params → string[] */
export const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    (Array.isArray(value) ? value : value ? value.split(",") : [])
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 50),
  );

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const email = z.string().trim().toLowerCase().max(254).email("Please enter a valid email address.");

export const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use at most 128 characters.")
  .regex(/[A-Za-z]/, "Include at least one letter.")
  .regex(/[0-9]/, "Include at least one number.");

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.");

export const id = z.string().trim().min(1).max(64);

export const money = z.coerce.number().min(0).max(10_000_000).multipleOf(0.01, "At most two decimal places.");

export const phone = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s]{10,15}$/, "Please enter a valid phone number.");

/** International numbers, e.g. "+44 20 7946 0958" or "+1 (212) 555-0100". */
const internationalPhone = /^\+?[0-9][0-9\-\s().]{5,22}$/;
const internationalPostalCode = /^[A-Za-z0-9][A-Za-z0-9 \-]{1,11}$/;

/**
 * Field shapes shared by saved and checkout addresses. Rules that depend on
 * the country (6-digit PIN and a state for India; any postal code format
 * abroad) are applied by addressProblems once the country is known.
 */
export const addressFields = {
  fullName: z.string().trim().min(2, "Please enter the full name.").max(120),
  line1: z.string().trim().min(4, "Please enter the address.").max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(2, "Please enter the city.").max(80),
  state: z.string().trim().max(80).default(""),
  postalCode: z.string().trim().min(1, "Please enter a postal code.").max(12, "Please enter a valid postal code."),
  country: z.string().trim().min(2).max(80).default("India"),
  phone: z.string().trim().min(1, "Please enter a valid phone number.").max(24, "Please enter a valid phone number."),
};

export function addressProblems(address: { country: string; state: string; postalCode: string; phone: string }): Record<string, string> | null {
  const problems: Record<string, string> = {};
  if (isIndia(address.country)) {
    if (!/^[0-9]{6}$/.test(address.postalCode)) problems.postalCode = "Please enter a valid 6-digit PIN code.";
    if (address.state.length < 2) problems.state = "Please enter the state.";
    if (!phone.safeParse(address.phone).success) problems.phone = "Please enter a valid phone number.";
  } else {
    if (!internationalPostalCode.test(address.postalCode)) problems.postalCode = "Please enter a valid postal code.";
    if (!internationalPhone.test(address.phone)) problems.phone = "Please enter a valid phone number with country code.";
  }
  return Object.keys(problems).length ? problems : null;
}

/** Adds addressProblems to a schema whose output is an address. */
export function withAddressRules<T extends { country: string; state: string; postalCode: string; phone: string }>(value: T, ctx: z.RefinementCtx) {
  for (const [path, message] of Object.entries(addressProblems(value) ?? {})) ctx.addIssue({ code: "custom", path: [path], message });
}

export const addressShape = z.object({
  label: z.string().trim().min(1).max(40).default("Home"),
  ...addressFields,
  isDefault: z.boolean().default(false),
});

export const addressInput = addressShape.superRefine(withAddressRules);

/** Partial update: no defaults, so omitted fields keep their stored values. Check the merged address with addressProblems. */
export const addressPatch = z
  .object({
    ...addressFields,
    label: z.string().trim().min(1).max(40),
    state: z.string().trim().max(80),
    country: z.string().trim().min(2).max(80),
    isDefault: z.boolean(),
  })
  .partial();
