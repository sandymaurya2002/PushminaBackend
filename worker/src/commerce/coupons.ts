import { toRupees } from "../lib/util";
import type { Currency } from "./currency";

export interface CouponRow {
  id: string;
  code: string;
  label: string;
  description: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  minimum_subtotal_paise: number | null;
  max_discount_paise: number | null;
  usage_limit: number | null;
  per_user_limit: number | null;
  used_count: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export type CouponProblem =
  | "COUPON_NOT_FOUND"
  | "COUPON_INACTIVE"
  | "COUPON_NOT_STARTED"
  | "COUPON_EXPIRED"
  | "COUPON_EXHAUSTED"
  | "COUPON_LIMIT_REACHED"
  | "COUPON_MINIMUM_NOT_MET"
  | "COUPON_CURRENCY";

export type CouponResult =
  | { ok: true; coupon: CouponRow; discountPaise: number }
  | { ok: false; code: CouponProblem; message: string; coupon?: CouponRow };

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export async function findCoupon(db: D1Database, code: string): Promise<CouponRow | null> {
  return db.prepare(`SELECT * FROM coupons WHERE code = ? COLLATE NOCASE`).bind(normalizeCode(code)).first<CouponRow>();
}

export function discountFor(coupon: CouponRow, subtotalPaise: number): number {
  const raw = coupon.type === "PERCENT" ? Math.floor((subtotalPaise * coupon.value) / 100) : coupon.value * 100;
  const capped = coupon.max_discount_paise ? Math.min(raw, coupon.max_discount_paise) : raw;
  return Math.max(0, Math.min(capped, subtotalPaise));
}

/**
 * Coupon amounts (fixed value, minimum spend, discount cap) are in rupees, and
 * prices are never converted, so outside India only a plain percentage code
 * can apply.
 */
export function couponWorksIn(coupon: CouponRow, currency: Currency): boolean {
  return currency === "INR" || (coupon.type === "PERCENT" && !coupon.minimum_subtotal_paise && !coupon.max_discount_paise);
}

/**
 * Validates a coupon against a subtotal (minor units of `currency`) and the
 * customer's past use. Dates are ISO strings or YYYY-MM-DD.
 */
export async function evaluateCoupon(db: D1Database, code: string, subtotalPaise: number, userId?: string, currency: Currency = "INR"): Promise<CouponResult> {
  const coupon = await findCoupon(db, code);
  if (!coupon) return { ok: false, code: "COUPON_NOT_FOUND", message: "That code isn't valid." };
  const now = new Date().toISOString();
  if (coupon.is_active !== 1) return { ok: false, code: "COUPON_INACTIVE", message: "That code is no longer active.", coupon };
  if (coupon.starts_at && coupon.starts_at > now) return { ok: false, code: "COUPON_NOT_STARTED", message: "That code isn't active yet.", coupon };
  if (coupon.ends_at && endOf(coupon.ends_at) < now) return { ok: false, code: "COUPON_EXPIRED", message: "That code has expired.", coupon };
  if (!couponWorksIn(coupon, currency)) {
    return { ok: false, code: "COUPON_CURRENCY", message: "This code can only be used on orders paid in Indian Rupees (₹).", coupon };
  }
  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) {
    return { ok: false, code: "COUPON_EXHAUSTED", message: "That code has been fully redeemed.", coupon };
  }
  if (userId && coupon.per_user_limit !== null) {
    const used = await db
      .prepare(`SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?`)
      .bind(coupon.id, userId)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= coupon.per_user_limit) {
      return { ok: false, code: "COUPON_LIMIT_REACHED", message: "You've already used this code.", coupon };
    }
  }
  if (coupon.minimum_subtotal_paise && subtotalPaise < coupon.minimum_subtotal_paise) {
    return {
      ok: false,
      code: "COUPON_MINIMUM_NOT_MET",
      message: `Spend ₹${toRupees(coupon.minimum_subtotal_paise).toLocaleString("en-IN")} or more to use this code.`,
      coupon,
    };
  }
  return { ok: true, coupon, discountPaise: discountFor(coupon, subtotalPaise) };
}

/** A date-only end (YYYY-MM-DD) is inclusive of that whole day. */
function endOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

export function couponDto(coupon: CouponRow) {
  return {
    code: coupon.code,
    label: coupon.label || coupon.code,
    type: coupon.type.toLowerCase(),
    value: coupon.value,
    ...(coupon.minimum_subtotal_paise ? { minimumSubtotal: toRupees(coupon.minimum_subtotal_paise) } : {}),
  };
}

export function adminCouponDto(coupon: CouponRow & { redemptions?: number }) {
  return {
    id: coupon.id,
    code: coupon.code,
    label: coupon.label,
    description: coupon.description,
    type: coupon.type,
    value: coupon.value,
    minimumSubtotal: coupon.minimum_subtotal_paise === null ? null : toRupees(coupon.minimum_subtotal_paise),
    maxDiscount: coupon.max_discount_paise === null ? null : toRupees(coupon.max_discount_paise),
    usageLimit: coupon.usage_limit,
    usageCount: coupon.used_count,
    perUserLimit: coupon.per_user_limit,
    startsAt: coupon.starts_at,
    endsAt: coupon.ends_at,
    isActive: coupon.is_active === 1,
    createdAt: coupon.created_at,
    updatedAt: coupon.updated_at,
    _count: { usages: coupon.redemptions ?? coupon.used_count },
  };
}
