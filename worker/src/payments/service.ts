import { loadCommerceRules } from "../content/settings";
import { currencyOf, formatMoney, type Currency } from "../commerce/currency";
import { refundRequestStatement, transitionOrder, notifyOrderConfirmed, notifyStatus, AWAITING_PAYMENT, type OrderRow } from "../commerce/orders";
import type { Config, RazorpayConfig } from "../env";
import { actorAuditStatement, type Actor } from "../lib/audit";
import { conflict, notFound, serviceUnavailable } from "../lib/errors";
import { newId } from "../lib/util";
import {
  capturePayment,
  createRazorpayOrder,
  createRefund,
  fetchOrderPayments,
  fetchPaymentRefunds,
  RazorpayError,
  type RazorpayPayment,
  type RazorpayRefund,
} from "./razorpay";

export interface PaymentOps extends Actor {
  config: Config;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: "razorpay" | "cod" | "manual";
  provider_order_id: string | null;
  provider_payment_id: string | null;
  method: string | null;
  status: "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "CANCELLED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  amount_paise: number;
  amount_refunded_paise: number;
  currency: string;
  failure_reason: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  authorized_at: string | null;
  captured_at: string | null;
  failed_at: string | null;
}

export interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  provider: "razorpay" | "manual";
  provider_refund_id: string | null;
  amount_paise: number;
  reason: string | null;
  notes: string | null;
  status: "REQUESTED" | "PROCESSING" | "COMPLETED" | "REJECTED" | "FAILED";
  failure_reason: string | null;
  requested_by: string | null;
  processed_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function requireRazorpay(config: Config): RazorpayConfig {
  if (!config.razorpay) throw serviceUnavailable("PAYMENTS_UNAVAILABLE", "Online payment is not available right now.");
  return config.razorpay;
}

async function getOrder(db: D1Database, orderId: string): Promise<OrderRow> {
  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first<OrderRow>();
  if (!order) throw notFound("Order");
  return order;
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

export interface CheckoutPayload {
  provider: "razorpay";
  keyId: string;
  razorpayOrderId: string;
  amount: number;
  currency: Currency;
  name: string;
  description: string;
  orderId: string;
  orderNumber: string;
  prefill: { name: string; email: string; contact: string };
  expiresAt: string | null;
}

/**
 * Returns the Razorpay order to pay this order with, creating it on first use.
 * The same Razorpay order is reused for every retry, and Razorpay accepts at
 * most one successful payment per order, so a customer cannot pay twice.
 */
export async function checkoutPayload(ops: PaymentOps, order: OrderRow): Promise<CheckoutPayload> {
  const razorpay = requireRazorpay(ops.config);
  if (order.payment_method !== "RAZORPAY" || !AWAITING_PAYMENT.includes(order.status)) {
    throw conflict("ORDER_NOT_PAYABLE", "This order is not awaiting payment.");
  }
  if (order.payment_expires_at && order.payment_expires_at < Date.now()) {
    throw conflict("PAYMENT_WINDOW_EXPIRED", "The time to pay for this order has run out. Please place it again.");
  }

  let providerOrderId = (
    await ops.db
      .prepare(`SELECT provider_order_id FROM payments WHERE order_id = ? AND provider = 'razorpay' AND provider_order_id IS NOT NULL ORDER BY rowid LIMIT 1`)
      .bind(order.id)
      .first<{ provider_order_id: string }>()
  )?.provider_order_id;

  if (!providerOrderId) {
    let created;
    try {
      created = await createRazorpayOrder(razorpay, {
        amountPaise: order.total_paise,
        currency: currencyOf(order.currency),
        receipt: order.order_number,
        notes: { order_id: order.id, order_number: order.order_number },
      });
    } catch (error) {
      console.error("razorpay order create failed", order.order_number, (error as RazorpayError)?.code, (error as Error)?.message);
      throw serviceUnavailable("PAYMENT_START_FAILED", "We couldn't start the payment. Please try again in a moment.");
    }
    if (created.amount !== order.total_paise || created.currency !== currencyOf(order.currency)) {
      throw serviceUnavailable("PAYMENT_START_FAILED", "Payment amount mismatch. Please try again.");
    }
    await ops.db.batch([
      ops.db
        .prepare(`INSERT INTO payments (id, order_id, provider, provider_order_id, status, amount_paise, currency) VALUES (?, ?, 'razorpay', ?, 'CREATED', ?, ?)`)
        .bind(newId(), order.id, created.id, order.total_paise, created.currency),
      actorAuditStatement(ops, {
        action: "payment.initiated",
        entityType: "order",
        targetId: order.id,
        metadata: { providerOrderId: created.id, amount: order.total_paise, currency: created.currency },
      }),
    ]);
    providerOrderId = created.id;
  }

  return {
    provider: "razorpay",
    keyId: razorpay.keyId,
    razorpayOrderId: providerOrderId,
    amount: order.total_paise,
    currency: currencyOf(order.currency),
    name: "Pashmore",
    description: `Order ${order.order_number}`,
    orderId: order.id,
    orderNumber: order.order_number,
    prefill: { name: order.shipping_name, email: order.shipping_email, contact: order.shipping_phone },
    expiresAt: order.payment_expires_at ? new Date(order.payment_expires_at).toISOString() : null,
  };
}

/** A failed attempt can be retried within the window; this reopens the order for payment. */
export async function reopenForPayment(ops: PaymentOps, order: OrderRow): Promise<OrderRow> {
  if (order.status !== "PAYMENT_FAILED") return order;
  await ops.db
    .prepare(
      `UPDATE orders SET status = 'PAYMENT_PENDING', payment_status = 'PENDING', status_note = 'Payment retried', status_changed_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'PAYMENT_FAILED'`,
    )
    .bind(ops.actorId, order.id)
    .run();
  return getOrder(ops.db, order.id);
}

/* ------------------------------------------------------------------ *
 * Recording gateway payments
 * ------------------------------------------------------------------ */

/** The gateway took exactly the order total, in the order's currency. */
function paysInFull(payment: RazorpayPayment, order: OrderRow): boolean {
  return payment.amount === order.total_paise && payment.currency === currencyOf(order.currency);
}

/** Ensures a payments row exists for this gateway payment id (claiming the placeholder row of the Razorpay order first). */
function paymentRowStatements(db: D1Database, orderId: string, payment: RazorpayPayment): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE payments SET provider_payment_id = ?1, updated_at = CURRENT_TIMESTAMP
          WHERE id = (SELECT id FROM payments WHERE order_id = ?2 AND provider_order_id = ?3 AND provider_payment_id IS NULL ORDER BY rowid LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM payments WHERE provider_payment_id = ?1)`,
      )
      .bind(payment.id, orderId, payment.order_id),
    db
      .prepare(
        `INSERT OR IGNORE INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, status, amount_paise, currency) VALUES (?, ?, 'razorpay', ?, ?, 'CREATED', ?, ?)`,
      )
      .bind(newId(), orderId, payment.order_id, payment.id, payment.amount, payment.currency),
  ];
}

export type RecordOutcome = "PAID" | "ALREADY_PAID" | "FAILED" | "AUTHORIZED" | "REFUNDING" | "MISMATCH" | "IGNORED";

/**
 * Applies a payment as reported by Razorpay (fetched from its API or from a
 * signed webhook, never from the browser). Idempotent: replays and
 * out-of-order deliveries leave the same end state.
 */
export async function recordGatewayPayment(ops: PaymentOps, orderId: string, payment: RazorpayPayment, source: string): Promise<RecordOutcome> {
  const db = ops.db;
  let order = await getOrder(db, orderId);
  const known = await db
    .prepare(`SELECT 1 AS ok FROM payments WHERE order_id = ? AND provider_order_id = ?`)
    .bind(order.id, payment.order_id)
    .first();
  if (!known) {
    console.warn("payment for an unknown razorpay order ignored", payment.id, payment.order_id);
    return "IGNORED";
  }

  if (payment.status === "authorized") {
    if (!AWAITING_PAYMENT.includes(order.status) || !paysInFull(payment, order)) {
      // Not captured: Razorpay releases the hold back to the customer automatically.
      await db.batch([
        ...paymentRowStatements(db, order.id, payment),
        db
          .prepare(
            `UPDATE payments SET status = 'AUTHORIZED', method = ?, authorized_at = COALESCE(authorized_at, CURRENT_TIMESTAMP), failure_reason = ?, updated_at = CURRENT_TIMESTAMP
              WHERE provider_payment_id = ? AND status IN ('CREATED','FAILED')`,
          )
          .bind(payment.method, "Not captured: order no longer awaiting this payment", payment.id),
      ]);
      return "AUTHORIZED";
    }
    try {
      payment = await capturePayment(requireRazorpay(ops.config), payment.id, payment.amount, currencyOf(order.currency));
    } catch (error) {
      // Already captured elsewhere (e.g. by auto-capture or a parallel webhook) is fine; anything else is retried by the next event.
      if (!(error instanceof RazorpayError) || !/already been captured/i.test(error.message)) {
        console.error("razorpay capture failed", payment.id, (error as Error)?.message);
        return "AUTHORIZED";
      }
      payment = { ...payment, status: "captured", captured: true };
    }
  }

  if (payment.status === "failed") {
    await db.batch([
      ...paymentRowStatements(db, order.id, payment),
      db
        .prepare(
          `UPDATE payments SET status = 'FAILED', method = ?, failure_reason = ?, error_code = ?, failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE provider_payment_id = ? AND status IN ('CREATED','AUTHORIZED')`,
        )
        .bind(payment.method, payment.error_description ?? "Payment failed", payment.error_code, payment.id),
      db
        .prepare(
          `UPDATE orders SET status = 'PAYMENT_FAILED', payment_status = 'FAILED', status_note = ?, status_changed_by = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'PAYMENT_PENDING'`,
        )
        .bind(`Payment failed: ${payment.error_description ?? "declined"}`.slice(0, 300), order.id),
      actorAuditStatement(ops, { action: "payment.failed", entityType: "order", targetId: order.id, metadata: { paymentId: payment.id, source, code: payment.error_code } }),
    ]);
    return "FAILED";
  }

  if (payment.status !== "captured" && payment.status !== "refunded") return "IGNORED";

  const amountMatches = paysInFull(payment, order);
  const results = await db.batch([
    ...paymentRowStatements(db, order.id, payment),
    db
      .prepare(
        `UPDATE payments SET status = 'CAPTURED', method = ?, amount_paise = ?, captured_at = COALESCE(captured_at, CURRENT_TIMESTAMP),
                failure_reason = ?, error_code = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE provider_payment_id = ? AND status IN ('CREATED','AUTHORIZED','FAILED')`,
      )
      .bind(payment.method, payment.amount, amountMatches ? null : "Amount or currency does not match the order total; review before shipping", payment.id),
    db
      .prepare(
        `UPDATE orders SET status = 'PAID', payment_status = 'PAID', paid_at = CURRENT_TIMESTAMP, payment_expires_at = NULL,
                status_note = 'Payment received', status_changed_by = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('PAYMENT_PENDING','PAYMENT_FAILED') AND total_paise = ? AND currency = ?`,
      )
      .bind(order.id, payment.amount, payment.currency),
  ]);

  if ((results[3]?.meta.changes ?? 0) > 0) {
    await db.batch([actorAuditStatement(ops, { action: "payment.captured", entityType: "order", targetId: order.id, metadata: { paymentId: payment.id, amount: payment.amount, source } })]);
    ops.waitUntil(notifyOrderConfirmed(ops.config, db, order.id));
    return "PAID";
  }

  order = await getOrder(db, order.id);
  if (!amountMatches) {
    await db.batch([
      actorAuditStatement(ops, { action: "payment.amount_mismatch", entityType: "order", targetId: order.id, metadata: { paymentId: payment.id, amount: payment.amount, currency: payment.currency, expected: order.total_paise, expectedCurrency: order.currency } }),
    ]);
    return "MISMATCH";
  }
  if (order.status === "CANCELLED" && (order.payment_status === "UNPAID" || order.payment_status === "FAILED" || order.payment_status === "PENDING")) {
    // Money arrived for an order that was cancelled (e.g. the payment window lapsed): refund it in full automatically.
    await db.batch([
      db
        .prepare(`UPDATE orders SET payment_status = 'PAID', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'CANCELLED' AND payment_status IN ('UNPAID','FAILED','PENDING')`)
        .bind(order.id),
      db.prepare(`UPDATE orders SET payment_status = 'REFUND_PENDING' WHERE id = ? AND status = 'CANCELLED' AND payment_status = 'PAID'`).bind(order.id),
      refundRequestStatement(db, order.id, "Payment received after the order was cancelled", null),
      db
        .prepare(
          `UPDATE orders SET status = 'REFUND_PENDING', status_note = 'Late payment, refunding automatically', status_changed_by = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'CANCELLED' AND payment_status = 'REFUND_PENDING'`,
        )
        .bind(order.id),
      actorAuditStatement(ops, { action: "payment.late_capture", entityType: "order", targetId: order.id, metadata: { paymentId: payment.id, source } }),
    ]);
    const refund = await db.prepare(`SELECT * FROM refunds WHERE order_id = ? AND status = 'REQUESTED' ORDER BY rowid DESC LIMIT 1`).bind(order.id).first<RefundRow>();
    if (refund) await processRefund({ ...ops, actorId: null }, refund.id).catch((error) => console.error("auto refund failed", order.id, (error as Error)?.message));
    return "REFUNDING";
  }
  return "ALREADY_PAID";
}

/** Pulls every payment attempt for the order from Razorpay and applies it. */
export async function syncOrderPayments(ops: PaymentOps, orderId: string, source = "sync"): Promise<RecordOutcome[]> {
  const razorpay = requireRazorpay(ops.config);
  const { results } = await ops.db
    .prepare(`SELECT DISTINCT provider_order_id FROM payments WHERE order_id = ? AND provider = 'razorpay' AND provider_order_id IS NOT NULL`)
    .bind(orderId)
    .all<{ provider_order_id: string }>();
  const outcomes: RecordOutcome[] = [];
  for (const row of results) {
    const payments = await fetchOrderPayments(razorpay, row.provider_order_id);
    // Successful payments first, so a later failure of another attempt never masks a capture.
    payments.sort((a, b) => rank(a) - rank(b));
    for (const payment of payments) outcomes.push(await recordGatewayPayment(ops, orderId, payment, source));
  }
  return outcomes;
}

const rank = (payment: RazorpayPayment) => (payment.status === "captured" || payment.status === "refunded" ? 0 : payment.status === "authorized" ? 1 : 2);

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

/**
 * Razorpay answers a refund it cannot fund (merchant balance too low; in Test
 * Mode the balance stays at zero until captured test payments settle) with a
 * bare "invalid request sent", which tells an admin nothing.
 */
function refundFailureMessage(error: unknown): string {
  if (!(error instanceof RazorpayError)) return "Razorpay could not be reached.";
  if (error.status === 400 && /^invalid request sent$/i.test(error.message)) {
    return "the account balance most likely cannot cover it yet. Check the balance in the Razorpay Dashboard and approve again later.";
  }
  return error.message;
}

/**
 * Approves and executes a refund. REQUESTED/FAILED -> PROCESSING is a
 * compare-and-set, so two admins clicking at once produce one refund. Before
 * calling Razorpay we look for a refund already created for this id (a
 * timed-out earlier attempt), so a retry never refunds twice.
 */
export async function processRefund(ops: PaymentOps, refundId: string): Promise<RefundRow> {
  const db = ops.db;
  const refund = await db.prepare(`SELECT * FROM refunds WHERE id = ?`).bind(refundId).first<RefundRow>();
  if (!refund) throw notFound("Refund");
  if (refund.status !== "REQUESTED" && refund.status !== "FAILED") throw conflict("REFUND_NOT_PENDING", `This refund is already ${refund.status.toLowerCase()}.`);

  let claimed: D1Result[];
  try {
    claimed = await db.batch([
      db
        .prepare(`UPDATE refunds SET status = 'PROCESSING', processed_by = ?, failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`)
        .bind(ops.actorId, refund.id, refund.status),
      actorAuditStatement(ops, { action: "refund.approve", entityType: "order", targetId: refund.order_id, metadata: { refundId: refund.id, amount: refund.amount_paise } }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message))) throw conflict("REFUND_ALREADY_OPEN", "Another refund for this order is already in progress.");
    throw error;
  }
  if ((claimed[0]?.meta.changes ?? 0) === 0) throw conflict("REFUND_CHANGED", "This refund was just updated by someone else. Reload and try again.");
  // Payment status follows the request: the refund is now in progress.
  await db.prepare(`UPDATE orders SET payment_status = 'REFUND_PENDING', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status IN ('PAID','PARTIALLY_REFUNDED')`).bind(refund.order_id).run();

  if (refund.provider === "manual") {
    // Cash on delivery and other offline payments are refunded outside the gateway; approval records that it was done.
    await completeRefund(ops, refund.id, null);
    return (await db.prepare(`SELECT * FROM refunds WHERE id = ?`).bind(refund.id).first<RefundRow>())!;
  }

  const payment = refund.payment_id ? await db.prepare(`SELECT * FROM payments WHERE id = ?`).bind(refund.payment_id).first<PaymentRow>() : null;
  if (!payment?.provider_payment_id) {
    await failRefund(ops, refund.id, "No captured payment found to refund.");
    throw conflict("REFUND_NO_PAYMENT", "There is no captured payment to refund on this order.");
  }

  const razorpay = requireRazorpay(ops.config);
  let gatewayRefund: RazorpayRefund | undefined;
  try {
    const existing = await fetchPaymentRefunds(razorpay, payment.provider_payment_id);
    gatewayRefund = existing.find((entry) => entry.receipt === refund.id || (entry.notes && !Array.isArray(entry.notes) && entry.notes.refund_id === refund.id));
    gatewayRefund ??= await createRefund(razorpay, payment.provider_payment_id, {
      amountPaise: refund.amount_paise,
      receipt: refund.id,
      notes: { refund_id: refund.id, order_id: refund.order_id },
    });
  } catch (error) {
    const message = refundFailureMessage(error);
    await failRefund(ops, refund.id, message);
    throw serviceUnavailable("REFUND_FAILED", `Razorpay rejected the refund: ${message}`);
  }

  await db.prepare(`UPDATE refunds SET provider_refund_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(gatewayRefund.id, refund.id).run();
  if (gatewayRefund.status === "processed") await completeRefund(ops, refund.id, gatewayRefund.id);
  else if (gatewayRefund.status === "failed") await failRefund(ops, refund.id, "Razorpay reported the refund as failed.");
  return (await db.prepare(`SELECT * FROM refunds WHERE id = ?`).bind(refund.id).first<RefundRow>())!;
}

/** Marks a refund complete; the refunds_complete trigger applies it to the payment and order exactly once. */
export async function completeRefund(ops: PaymentOps, refundId: string, providerRefundId: string | null): Promise<boolean> {
  const results = await ops.db.batch([
    ops.db
      .prepare(
        `UPDATE refunds SET status = 'COMPLETED', provider_refund_id = COALESCE(provider_refund_id, ?), completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('REQUESTED','PROCESSING','FAILED')`,
      )
      .bind(providerRefundId, refundId),
  ]);
  const done = (results[0]?.meta.changes ?? 0) > 0;
  if (done) {
    const refund = await ops.db.prepare(`SELECT order_id, amount_paise FROM refunds WHERE id = ?`).bind(refundId).first<{ order_id: string; amount_paise: number }>();
    if (refund) {
      await ops.db.batch([actorAuditStatement(ops, { action: "refund.completed", entityType: "order", targetId: refund.order_id, metadata: { refundId, amount: refund.amount_paise } })]);
      const order = await ops.db.prepare(`SELECT status FROM orders WHERE id = ?`).bind(refund.order_id).first<{ status: string }>();
      if (order?.status === "REFUNDED") ops.waitUntil(notifyStatus(ops.config, ops.db, refund.order_id, "REFUNDED"));
    }
  }
  return done;
}

export async function failRefund(ops: PaymentOps, refundId: string, reason: string): Promise<void> {
  await ops.db.batch([
    ops.db
      .prepare(`UPDATE refunds SET status = 'FAILED', failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('REQUESTED','PROCESSING')`)
      .bind(reason.slice(0, 500), refundId),
  ]);
}

/**
 * Declines a refund request. The order's payment status goes back to what
 * was actually paid, and an order parked in REFUND_PENDING returns to the
 * state it came from (cancelled or returned) without restocking again.
 */
export async function rejectRefund(ops: PaymentOps, refundId: string, reason: string): Promise<void> {
  const db = ops.db;
  const refund = await db.prepare(`SELECT * FROM refunds WHERE id = ?`).bind(refundId).first<RefundRow>();
  if (!refund) throw notFound("Refund");
  const results = await db.batch([
    db
      .prepare(`UPDATE refunds SET status = 'REJECTED', notes = ?, processed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('REQUESTED','FAILED')`)
      .bind(reason, ops.actorId, refund.id),
    db
      .prepare(
        `UPDATE orders SET payment_status = CASE WHEN refunded_paise > 0 THEN 'PARTIALLY_REFUNDED' ELSE 'PAID' END, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?1 AND payment_status = 'REFUND_PENDING'
            AND NOT EXISTS (SELECT 1 FROM refunds WHERE order_id = ?1 AND status IN ('REQUESTED','PROCESSING'))`,
      )
      .bind(refund.order_id),
    db
      .prepare(
        `UPDATE orders
            SET status = COALESCE((SELECT h.from_status FROM order_status_history h WHERE h.order_id = orders.id AND h.to_status = 'REFUND_PENDING' ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1), 'CANCELLED'),
                status_note = ?, status_changed_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'REFUND_PENDING' AND payment_status IN ('PAID','PARTIALLY_REFUNDED')`,
      )
      .bind(`Refund declined: ${reason}`.slice(0, 300), ops.actorId, refund.order_id),
    actorAuditStatement(ops, { action: "refund.reject", entityType: "order", targetId: refund.order_id, metadata: { refundId: refund.id, reason } }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw conflict("REFUND_NOT_PENDING", `This refund is already ${refund.status.toLowerCase()}.`);
}

/** An admin-initiated refund (e.g. a goodwill partial refund on a delivered order). */
export async function requestRefund(ops: PaymentOps, orderId: string, amountPaise: number | null, reason: string): Promise<RefundRow> {
  const db = ops.db;
  const order = await getOrder(db, orderId);
  if (!["PAID", "PARTIALLY_REFUNDED", "REFUND_PENDING"].includes(order.payment_status)) {
    throw conflict("NOT_REFUNDABLE", "Only paid orders can be refunded.");
  }
  const remaining = order.total_paise - order.refunded_paise;
  const amount = amountPaise ?? remaining;
  if (amount <= 0 || amount > remaining) {
    throw conflict("REFUND_AMOUNT_INVALID", `You can refund up to ${formatMoney(remaining, currencyOf(order.currency))}.`);
  }
  const payment = await db
    .prepare(`SELECT * FROM payments WHERE order_id = ? AND status IN ('CAPTURED','PARTIALLY_REFUNDED') ORDER BY captured_at DESC, rowid DESC LIMIT 1`)
    .bind(order.id)
    .first<PaymentRow>();
  const id = newId();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO refunds (id, order_id, payment_id, provider, amount_paise, reason, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`)
        .bind(id, order.id, payment?.id ?? null, order.payment_method === "RAZORPAY" ? "razorpay" : "manual", amount, reason, ops.actorId),
      db.prepare(`UPDATE orders SET payment_status = 'REFUND_PENDING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(order.id),
      db
        .prepare(
          `UPDATE orders SET status = 'REFUND_PENDING', status_note = 'Refund requested', status_changed_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('CANCELLED','RETURNED') AND ? >= total_paise - refunded_paise`,
        )
        .bind(ops.actorId, order.id, amount),
      actorAuditStatement(ops, { action: "refund.create", entityType: "order", targetId: order.id, metadata: { refundId: id, amount, reason } }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message))) throw conflict("REFUND_ALREADY_OPEN", "This order already has a refund in progress.");
    throw error;
  }
  return (await db.prepare(`SELECT * FROM refunds WHERE id = ?`).bind(id).first<RefundRow>())!;
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

interface WebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPayment };
    refund?: { entity?: RazorpayRefund };
    order?: { entity?: { id: string } };
  };
}

/**
 * Handles one verified webhook delivery. Each event id is stored first, so a
 * redelivery of an event that was already processed is acknowledged and
 * skipped.
 */
export async function handleWebhook(ops: PaymentOps, eventId: string, body: WebhookBody, raw: string): Promise<"processed" | "duplicate" | "ignored"> {
  const db = ops.db;
  const event = body.event ?? "unknown";
  const payment = body.payload?.payment?.entity;
  const refund = body.payload?.refund?.entity;
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_events (id, provider, event, provider_order_id, provider_payment_id, provider_refund_id, payload_json) VALUES (?, 'razorpay', ?, ?, ?, ?, ?)`,
    )
    .bind(eventId, event, payment?.order_id ?? body.payload?.order?.entity?.id ?? null, payment?.id ?? refund?.payment_id ?? null, refund?.id ?? null, raw.slice(0, 20_000))
    .run();
  const stored = await db.prepare(`SELECT status FROM payment_events WHERE id = ?`).bind(eventId).first<{ status: string }>();
  if (stored?.status === "PROCESSED" || stored?.status === "IGNORED") return "duplicate";

  let outcome: "processed" | "ignored" = "ignored";
  try {
    if (payment && /^payment\.|^order\.paid$/.test(event) && payment.order_id) {
      const owner = await db.prepare(`SELECT order_id FROM payments WHERE provider_order_id = ? LIMIT 1`).bind(payment.order_id).first<{ order_id: string }>();
      if (owner) {
        const result = await recordGatewayPayment(ops, owner.order_id, payment, `webhook:${event}`);
        outcome = result === "IGNORED" ? "ignored" : "processed";
      }
    } else if (refund && /^refund\./.test(event)) {
      const notes = refund.notes && !Array.isArray(refund.notes) ? refund.notes : {};
      const ours = await db
        .prepare(`SELECT * FROM refunds WHERE provider_refund_id = ? OR id = ? LIMIT 1`)
        .bind(refund.id, notes.refund_id ?? "")
        .first<RefundRow>();
      if (ours) {
        if (event === "refund.processed") await completeRefund(ops, ours.id, refund.id);
        else if (event === "refund.failed") await failRefund(ops, ours.id, "Razorpay reported the refund as failed.");
        else await db.prepare(`UPDATE refunds SET provider_refund_id = COALESCE(provider_refund_id, ?) WHERE id = ?`).bind(refund.id, ours.id).run();
        outcome = "processed";
      } else if (event === "refund.processed") {
        outcome = (await recordExternalRefund(ops, refund)) ? "processed" : "ignored";
      }
    }
    await db.prepare(`UPDATE payment_events SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(outcome === "processed" ? "PROCESSED" : "IGNORED", eventId).run();
    return outcome;
  } catch (error) {
    await db.prepare(`UPDATE payment_events SET status = 'FAILED', error = ? WHERE id = ?`).bind(String((error as Error)?.message ?? error).slice(0, 500), eventId).run();
    throw error;
  }
}

/** A refund issued from the Razorpay dashboard is recorded so payment and order totals stay true. */
async function recordExternalRefund(ops: PaymentOps, refund: RazorpayRefund): Promise<boolean> {
  const payment = await ops.db.prepare(`SELECT * FROM payments WHERE provider_payment_id = ?`).bind(refund.payment_id).first<PaymentRow>();
  if (!payment) return false;
  const id = newId();
  await ops.db
    .prepare(
      `INSERT OR IGNORE INTO refunds (id, order_id, payment_id, provider, provider_refund_id, amount_paise, reason, status) VALUES (?, ?, ?, 'razorpay', ?, ?, 'Refunded from the Razorpay dashboard', 'PROCESSING')`,
    )
    .bind(id, payment.order_id, payment.id, refund.id, refund.amount)
    .run();
  return completeRefund(ops, id, refund.id);
}

/* ------------------------------------------------------------------ *
 * Unpaid order expiry
 * ------------------------------------------------------------------ */

/**
 * Releases stock held by online orders whose payment window has passed. Each
 * order is reconciled with Razorpay first so a payment that did go through is
 * honoured rather than cancelled.
 */
export async function expireUnpaidOrders(ops: PaymentOps, limit = 25): Promise<{ checked: number; cancelled: number; paid: number }> {
  const { results } = await ops.db
    .prepare(
      `SELECT * FROM orders WHERE status IN ('PAYMENT_PENDING','PAYMENT_FAILED') AND payment_expires_at IS NOT NULL AND payment_expires_at < ? ORDER BY payment_expires_at LIMIT ?`,
    )
    .bind(Date.now(), limit)
    .all<OrderRow>();
  let cancelled = 0;
  let paid = 0;
  for (const stale of results) {
    try {
      if (ops.config.razorpay) {
        const outcomes = await syncOrderPayments(ops, stale.id, "expiry");
        if (outcomes.includes("PAID") || outcomes.includes("ALREADY_PAID")) {
          paid += 1;
          continue;
        }
        if (outcomes.includes("AUTHORIZED")) continue;
      }
      const order = await getOrder(ops.db, stale.id);
      if (!AWAITING_PAYMENT.includes(order.status)) continue;
      await transitionOrder(ops, order, "CANCELLED", { note: "Payment not completed in time; stock released", actorId: null, allowed: ["CANCELLED"] });
      cancelled += 1;
    } catch (error) {
      console.error("expire unpaid order failed", stale.order_number, (error as Error)?.message);
    }
  }
  return { checked: results.length, cancelled, paid };
}

export async function paymentWindowMinutes(db: D1Database): Promise<number> {
  return (await loadCommerceRules(db)).paymentWindowMinutes;
}
