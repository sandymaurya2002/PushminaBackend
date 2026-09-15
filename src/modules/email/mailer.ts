import nodemailer, { type Transporter } from 'nodemailer'
import { env, mailLive } from '../../config/env'
import { logger } from '../../config/logger'
import { prisma } from '../../db/prisma'

/**
 * Email delivery.
 *
 * With SMTP_HOST unset the transport logs the message and records it in
 * email_logs instead of sending, so the full notification path is exercisable
 * offline. Every send is logged either way, giving an auditable delivery trail.
 */

let transporter: Transporter | null = null

function getTransporter(): Transporter | null {
  if (!mailLive) return null
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  })

  return transporter
}

export interface SendMailInput {
  to: string
  subject: string
  html: string
  text?: string
  template: string
}

export async function sendMail(input: SendMailInput): Promise<boolean> {
  const transport = getTransporter()

  if (!transport) {
    logger.info(
      { to: input.to, subject: input.subject, template: input.template },
      'Email suppressed (SMTP not configured) — set SMTP_HOST in .env to send',
    )
    await prisma.emailLog
      .create({
        data: {
          to: input.to,
          subject: input.subject,
          template: input.template,
          status: 'skipped',
        },
      })
      .catch(() => undefined)
    return false
  }

  try {
    await transport.sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? stripHtml(input.html),
    })

    await prisma.emailLog.create({
      data: {
        to: input.to,
        subject: input.subject,
        template: input.template,
        status: 'sent',
      },
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ err: error, to: input.to }, 'Email send failed')
    await prisma.emailLog
      .create({
        data: {
          to: input.to,
          subject: input.subject,
          template: input.template,
          status: 'failed',
          error: message,
        },
      })
      .catch(() => undefined)
    return false
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
