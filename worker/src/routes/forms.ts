import { Hono } from "hono";
import { z } from "zod";
import { authenticateAccessToken, bearerToken } from "../auth/sessions";
import { siteSettings } from "../content/settings";
import { sendMail } from "../email/mailer";
import { ok, created } from "../lib/http";
import { newId } from "../lib/util";
import { body, email, phone } from "../lib/validation";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";

async function optionalCustomerId(c: Parameters<typeof bearerToken>[0]): Promise<string | null> {
  const token = bearerToken(c);
  if (!token) return null;
  try {
    return (await authenticateAccessToken(c.env.DB, token, "CUSTOMER"))?.userId ?? null;
  } catch {
    return null;
  }
}

const contactSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name.").max(120),
  email,
  phone: phone.optional().or(z.literal("").transform(() => undefined)),
  subject: z.string().trim().min(3, "Please give your message a subject.").max(160),
  orderNumber: z.string().trim().max(40).optional(),
  message: z.string().trim().min(20, "Please give us a little more detail — at least 20 characters.").max(5000),
  /** Honeypot: real visitors never fill this in. */
  website: z.string().max(0).optional(),
});

export const formRoutes = new Hono<AppEnv>();

formRoutes.post("/contact", rateLimit({ name: "contact", limit: 5, windowSeconds: 3600 }), async (c) => {
  const input = await body(c, contactSchema);
  const contactId = newId();
  const userId = await optionalCustomerId(c);
  await c.env.DB.prepare(
    `INSERT INTO contact_submissions (id, name, email, phone, subject, order_number, message, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(contactId, input.name, input.email, input.phone ?? null, input.subject, input.orderNumber || null, input.message, userId, c.get("clientIp") ?? null)
    .run();

  const config = c.get("config");
  c.executionCtx.waitUntil(
    siteSettings(c.env.DB).then((settings) =>
      sendMail(config, {
        to: settings["store.supportEmail"],
        subject: `New enquiry: ${input.subject}`,
        text: [
          `From: ${input.name} <${input.email}>`,
          ...(input.phone ? [`Phone: ${input.phone}`] : []),
          ...(input.orderNumber ? [`Order: ${input.orderNumber}`] : []),
          "",
          input.message,
        ].join("\n"),
        html: `<p><strong>${escapeHtml(input.name)}</strong> &lt;${escapeHtml(input.email)}&gt;</p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`,
      }),
    ),
  );
  return created(c, { id: contactId, received: true });
});

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const newsletterLimit = rateLimit({ name: "newsletter", limit: 10, windowSeconds: 3600 });

/** Always answers the same way, so the endpoint cannot be used to test which addresses are subscribed. */
formRoutes.post("/newsletter", newsletterLimit, async (c) => {
  const input = await body(c, z.object({ email, source: z.string().trim().max(60).optional() }));
  const userId = await optionalCustomerId(c);
  await c.env.DB.prepare(
    `INSERT INTO newsletter_subscribers (id, email, status, source, user_id) VALUES (?, ?, 'SUBSCRIBED', ?, ?)
     ON CONFLICT(email) DO UPDATE SET status = 'SUBSCRIBED', unsubscribed_at = NULL, user_id = COALESCE(newsletter_subscribers.user_id, excluded.user_id),
       subscribed_at = CASE WHEN newsletter_subscribers.status = 'UNSUBSCRIBED' THEN CURRENT_TIMESTAMP ELSE newsletter_subscribers.subscribed_at END`,
  )
    .bind(newId(), input.email, input.source ?? "website", userId)
    .run();
  return ok(c, { subscribed: true });
});

/** The token is the subscriber id, which only appears in links we send to that address. */
formRoutes.post("/newsletter/unsubscribe", newsletterLimit, async (c) => {
  const input = await body(c, z.object({ token: z.string().trim().min(8).max(64) }));
  await c.env.DB.prepare(`UPDATE newsletter_subscribers SET status = 'UNSUBSCRIBED', unsubscribed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'SUBSCRIBED'`)
    .bind(input.token)
    .run();
  return ok(c, { unsubscribed: true });
});
