import type { Config } from "../env";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends through Resend when RESEND_API_KEY is set. Without it the message is
 * dropped (or printed when EMAIL_DEV_LOG=true, which is for local use only as
 * it prints reset links). Never throws: email must not fail the request.
 */
export async function sendMail(config: Config, mail: Mail): Promise<boolean> {
  if (!config.resendApiKey) {
    if (config.emailDevLog) console.log(`[email:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    else console.warn(`[email] skipped (RESEND_API_KEY not set): ${mail.subject}`);
    return false;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.mailFrom, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[email] Resend returned ${response.status} for "${mail.subject}"`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[email] send failed for "${mail.subject}"`, (error as Error)?.message);
    return false;
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function layout(heading: string, paragraphs: string[], action?: { label: string; href: string }): string {
  const body = paragraphs.map((text) => `<p style="margin:0 0 16px;line-height:1.6">${escape(text)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escape(action.href)}" style="background:#2b2622;color:#f7f2ea;padding:12px 22px;text-decoration:none;letter-spacing:.08em;text-transform:uppercase;font-size:12px">${escape(action.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f7f2ea;font-family:Georgia,serif;color:#2b2622">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
<p style="letter-spacing:.3em;text-transform:uppercase;font-size:12px;color:#8a7a68">Pashmore</p>
<h1 style="font-weight:normal;font-size:26px;margin:0 0 24px">${escape(heading)}</h1>${body}${button}
<p style="margin-top:40px;font-size:12px;color:#8a7a68">Handcrafted in Kashmir. Questions? Reply to this email.</p>
</div></body></html>`;
}

function plain(heading: string, paragraphs: string[], action?: { label: string; href: string }): string {
  return [heading, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.href}`] : [])].join("\n");
}

function compose(to: string, subject: string, heading: string, paragraphs: string[], action?: { label: string; href: string }): Mail {
  return { to, subject, html: layout(heading, paragraphs, action), text: plain(heading, paragraphs, action) };
}

export function passwordResetMail(to: string, name: string, link: string, minutes: number): Mail {
  return compose(
    to,
    "Reset your Pashmore password",
    "Reset your password",
    [`Hello ${name || "there"},`, `We received a request to reset your password. The link below works once and expires in ${minutes} minutes.`, "If you didn't ask for this, you can ignore this email; your password stays the same."],
    { label: "Choose a new password", href: link },
  );
}

export function passwordChangedMail(to: string, name: string): Mail {
  return compose(to, "Your Pashmore password was changed", "Password changed", [
    `Hello ${name || "there"},`,
    "Your password was just changed and all other sessions were signed out.",
    "If this wasn't you, reset your password straight away and contact us.",
  ]);
}

export interface OrderMailInput {
  to: string;
  name: string;
  orderNumber: string;
  /** Already formatted in the order's currency, e.g. "₹8,999" or "$249". */
  total: string;
  link: string;
}

export function orderConfirmedMail(input: OrderMailInput & { paymentMethod: string }): Mail {
  const cod = input.paymentMethod === "COD";
  return compose(
    input.to,
    `Order ${input.orderNumber} confirmed`,
    "Thank you for your order",
    [
      `Hello ${input.name},`,
      `We've received order ${input.orderNumber} for ${input.total}${cod ? ", payable in cash on delivery" : " and your payment is confirmed"}.`,
      "Your pieces are being prepared in our Srinagar workshop. We'll write again with tracking details as soon as the parcel leaves us.",
    ],
    { label: "View your order", href: input.link },
  );
}

const STATUS_COPY: Record<string, { subject: string; heading: string; line: string }> = {
  SHIPPED: { subject: "is on its way", heading: "Your order has shipped", line: "Your parcel has left our workshop." },
  OUT_FOR_DELIVERY: { subject: "is out for delivery", heading: "Out for delivery", line: "Your parcel is with the courier for delivery today." },
  DELIVERED: { subject: "has been delivered", heading: "Delivered", line: "Your parcel has been delivered. We hope it is cherished for years." },
  CANCELLED: { subject: "has been cancelled", heading: "Order cancelled", line: "Your order has been cancelled. If you paid online, your refund is being processed." },
  RETURN_REQUESTED: { subject: "return requested", heading: "Return requested", line: "We've received your return request and will be in touch with collection details." },
  RETURNED: { subject: "return received", heading: "Return received", line: "Your return has reached us. Any refund due will follow shortly." },
  REFUNDED: { subject: "has been refunded", heading: "Refund issued", line: "Your refund has been issued to the original payment method. Banks can take 5–7 working days to show it." },
};

export function orderStatusMail(input: OrderMailInput & { status: string; trackingNumber?: string | null; carrier?: string | null; trackingUrl?: string | null }): Mail | null {
  const copy = STATUS_COPY[input.status];
  if (!copy) return null;
  const tracking =
    input.status === "SHIPPED" && input.trackingNumber
      ? [`Tracking: ${[input.carrier, input.trackingNumber].filter(Boolean).join(" ")}${input.trackingUrl ? ` (${input.trackingUrl})` : ""}`]
      : [];
  return compose(input.to, `Order ${input.orderNumber} ${copy.subject}`, copy.heading, [`Hello ${input.name},`, copy.line, ...tracking], {
    label: "View your order",
    href: input.link,
  });
}
