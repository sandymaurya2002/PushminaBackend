import { env } from '../../config/env'
import { formatINR } from '../../utils/money'

/**
 * Transactional email templates.
 *
 * Table-based layout with inline styles, because that is the only thing every
 * mail client renders consistently. The palette matches the storefront: warm
 * ivory ground, charcoal type, antique gold accents.
 */

const COLORS = {
  ivory: '#faf7f2',
  cream: '#f4eee4',
  charcoal: '#1f1d1a',
  mocha: '#7d6b56',
  taupe: '#a2917a',
  gold: '#b08d4f',
  line: '#e4ddd1',
}

function layout(body: string, preheader = ''): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;color:${COLORS.charcoal};">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.ivory};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${COLORS.line};">
        <tr><td style="padding:32px;text-align:center;border-bottom:1px solid ${COLORS.line};">
          <a href="${env.STOREFRONT_URL}" style="text-decoration:none;color:${COLORS.charcoal};font-size:22px;letter-spacing:6px;">PUSHMINA</a>
        </td></tr>
        <tr><td style="padding:36px 32px;">${body}</td></tr>
        <tr><td style="padding:24px 32px;background:${COLORS.cream};border-top:1px solid ${COLORS.line};text-align:center;font-family:Arial,sans-serif;font-size:12px;color:${COLORS.taupe};">
          <p style="margin:0 0 8px;">Handcrafted in Srinagar, Kashmir · Shipped worldwide</p>
          <p style="margin:0;">
            <a href="${env.STOREFRONT_URL}/track-order" style="color:${COLORS.mocha};">Track order</a> ·
            <a href="${env.STOREFRONT_URL}/contact" style="color:${COLORS.mocha};">Contact us</a> ·
            <a href="${env.STOREFRONT_URL}/returns" style="color:${COLORS.mocha};">Returns</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 20px;font-size:26px;font-weight:400;line-height:1.2;color:${COLORS.charcoal};">${escapeHtml(text)}</h1>`
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:${COLORS.mocha};">${text}</p>`
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0;"><tr>
    <td style="background:${COLORS.charcoal};">
      <a href="${href}" style="display:inline-block;padding:14px 32px;color:${COLORS.ivory};text-decoration:none;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(label)}</a>
    </td></tr></table>`
}

export interface OrderEmailItem {
  name: string
  quantity: number
  unitPrice: number
  colorName?: string | null
  sizeName?: string | null
}

function itemsTable(items: OrderEmailItem[], totals: Record<string, number>): string {
  const rows = items
    .map(
      (item) => `<tr>
        <td style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:Arial,sans-serif;font-size:14px;color:${COLORS.charcoal};">
          ${escapeHtml(item.name)}
          <span style="display:block;color:${COLORS.taupe};font-size:12px;margin-top:4px;">
            ${[item.colorName, item.sizeName].filter((value): value is string => Boolean(value)).map(escapeHtml).join(' · ')}${item.colorName || item.sizeName ? ' · ' : ''}Qty ${item.quantity}
          </span>
        </td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:Arial,sans-serif;font-size:14px;color:${COLORS.charcoal};white-space:nowrap;">
          ${formatINR(item.unitPrice * item.quantity)}
        </td>
      </tr>`,
    )
    .join('')

  const totalRow = (label: string, value: number, bold = false) =>
    `<tr>
      <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:${bold ? '16' : '13'}px;color:${bold ? COLORS.charcoal : COLORS.mocha};${bold ? 'font-weight:bold;padding-top:14px;' : ''}">${escapeHtml(label)}</td>
      <td align="right" style="padding:6px 0;font-family:Arial,sans-serif;font-size:${bold ? '16' : '13'}px;color:${bold ? COLORS.charcoal : COLORS.mocha};${bold ? 'font-weight:bold;padding-top:14px;' : ''}">${formatINR(value)}</td>
    </tr>`

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    ${rows}
    ${totalRow('Subtotal', totals.subtotal)}
    ${totals.discount > 0 ? totalRow('Discount', -totals.discount) : ''}
    ${totalRow('Shipping', totals.shippingFee)}
    ${totalRow('Total', totals.total, true)}
  </table>`
}

/* ------------------------------------------------------------------ */

export const templates = {
  welcome: (firstName: string) => ({
    subject: 'Welcome to Pushmina',
    html: layout(
      heading(`Welcome, ${escapeHtml(firstName)}`) +
        paragraph(
          'Your account is ready. You can now track orders, save addresses and keep your wishlist across devices.',
        ) +
        paragraph(
          'Every piece we make is hand-spun, handwoven and finished by artisan families in Kashmir, and ships with a certificate naming the weaver who made it.',
        ) +
        button('Explore the collection', `${env.STOREFRONT_URL}/collections`),
      'Your Pushmina account is ready.',
    ),
  }),

  orderPlaced: (input: {
    firstName: string
    orderNumber: string
    items: OrderEmailItem[]
    totals: Record<string, number>
  }) => ({
    subject: `Order ${input.orderNumber} confirmed`,
    html: layout(
      heading('Thank you for your order') +
        paragraph(
          `Order <strong style="color:${COLORS.charcoal};">${escapeHtml(input.orderNumber)}</strong> has been placed and will be dispatched from our Srinagar workshop within 48 hours.`,
        ) +
        itemsTable(input.items, input.totals) +
        button('View your order', `${env.STOREFRONT_URL}/account/orders`),
      `Order ${input.orderNumber} confirmed.`,
    ),
  }),

  paymentSuccessful: (input: { orderNumber: string; amount: number; method: string }) => ({
    subject: `Payment received for ${input.orderNumber}`,
    html: layout(
      heading('Payment received') +
        paragraph(
          `We have received <strong style="color:${COLORS.charcoal};">${formatINR(input.amount)}</strong> for order ${escapeHtml(input.orderNumber)} via ${escapeHtml(input.method)}.`,
        ) +
        button('View your order', `${env.STOREFRONT_URL}/account/orders`),
    ),
  }),

  paymentFailed: (input: { orderNumber: string; reason?: string }) => ({
    subject: `Payment could not be completed for ${input.orderNumber}`,
    html: layout(
      heading('Payment unsuccessful') +
        paragraph(
          `We could not complete the payment for order ${escapeHtml(input.orderNumber)}. No money has been taken.`,
        ) +
        (input.reason ? paragraph(`Reason: ${escapeHtml(input.reason)}`) : '') +
        paragraph('Your bag has been kept, so you can try again whenever you are ready.') +
        button('Try again', `${env.STOREFRONT_URL}/checkout`),
    ),
  }),

  orderShipped: (input: {
    orderNumber: string
    trackingNumber?: string | null
    carrier?: string | null
  }) => ({
    subject: `Order ${input.orderNumber} is on its way`,
    html: layout(
      heading('Your order has shipped') +
        paragraph(`Order ${escapeHtml(input.orderNumber)} has left our workshop.`) +
        (input.trackingNumber
          ? paragraph(
              `Tracking number: <strong style="color:${COLORS.charcoal};">${escapeHtml(input.trackingNumber)}</strong>${input.carrier ? ` (${escapeHtml(input.carrier)})` : ''}`,
            )
          : '') +
        button('Track your order', `${env.STOREFRONT_URL}/track-order`),
    ),
  }),

  orderDelivered: (input: { orderNumber: string }) => ({
    subject: `Order ${input.orderNumber} delivered`,
    html: layout(
      heading('Delivered') +
        paragraph(
          `Order ${escapeHtml(input.orderNumber)} has been delivered. We hope it is everything you expected.`,
        ) +
        paragraph(
          'Handwoven cloth needs a little care: air it rather than washing it, store it folded rather than on a hanger, and it will outlast you.',
        ) +
        button('Read the care guide', `${env.STOREFRONT_URL}/blog/how-to-care-for-pashmina`),
    ),
  }),

  orderCancelled: (input: { orderNumber: string; reason?: string }) => ({
    subject: `Order ${input.orderNumber} cancelled`,
    html: layout(
      heading('Order cancelled') +
        paragraph(`Order ${escapeHtml(input.orderNumber)} has been cancelled.`) +
        (input.reason ? paragraph(`Reason: ${escapeHtml(input.reason)}`) : '') +
        paragraph('Any payment taken will be refunded to the original payment method.'),
    ),
  }),

  refundCompleted: (input: { orderNumber: string; amount: number }) => ({
    subject: `Refund processed for ${input.orderNumber}`,
    html: layout(
      heading('Refund processed') +
        paragraph(
          `A refund of <strong style="color:${COLORS.charcoal};">${formatINR(input.amount)}</strong> for order ${escapeHtml(input.orderNumber)} has been processed.`,
        ) +
        paragraph(
          'Depending on your bank it can take a further 3–5 working days to appear on your statement.',
        ),
    ),
  }),

  passwordReset: (input: { firstName: string; resetUrl: string }) => ({
    subject: 'Reset your Pushmina password',
    html: layout(
      heading('Reset your password') +
        paragraph(`Hello ${escapeHtml(input.firstName)},`) +
        paragraph(
          'Use the button below to set a new password. The link is valid for one hour.',
        ) +
        button('Set a new password', input.resetUrl) +
        paragraph(
          'If you did not request this, you can ignore this email — your password will not change.',
        ),
    ),
  }),

  contactReceived: (input: { name: string; subject: string }) => ({
    subject: 'We have your message',
    html: layout(
      heading('Message received') +
        paragraph(`Thank you, ${escapeHtml(input.name)}.`) +
        paragraph(
          `Our care team in Srinagar will reply to your enquiry about "${escapeHtml(input.subject)}" within one working day.`,
        ),
    ),
  }),

  newsletterWelcome: (unsubscribeUrl: string) => ({
    subject: 'You are on the list',
    html: layout(
      heading('Welcome to the Pushmina journal') +
        paragraph(
          'You will hear from us when a new collection comes off the loom, and when we publish something worth reading. Not more often than that.',
        ) +
        button('Read the journal', `${env.STOREFRONT_URL}/blog`) +
        `<p style="margin:24px 0 0;font-family:Arial,sans-serif;font-size:12px;color:${COLORS.taupe};">
           Changed your mind? <a href="${unsubscribeUrl}" style="color:${COLORS.taupe};">Unsubscribe</a>.
         </p>`,
    ),
  }),
}
