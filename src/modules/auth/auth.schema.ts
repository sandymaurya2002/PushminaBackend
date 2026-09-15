import { z } from 'zod'
import { passwordSchema } from './password'

const email = z.string().trim().toLowerCase().email('Please enter a valid email address.')

export const registerSchema = z.object({
  firstName: z.string().trim().min(2, 'Please enter your first name.').max(60),
  lastName: z.string().trim().min(1, 'Please enter your last name.').max(60),
  email,
  password: passwordSchema,
  phone: z.string().trim().max(20).optional(),
  acceptsMarketing: z.boolean().default(false),
})

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Please enter your password.'),
})

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({
  token: z.string().min(16),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: passwordSchema,
})

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(2).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  acceptsMarketing: z.boolean().optional(),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(16).optional(),
})

export const addressSchema = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  fullName: z.string().trim().min(2, 'Please enter the full name.').max(120),
  line1: z.string().trim().min(4, 'Please enter the address.').max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(2, 'Please enter the city.').max(80),
  state: z.string().trim().min(2, 'Please enter the state.').max(80),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Please enter a valid 6-digit PIN code.'),
  country: z.string().trim().max(80).default('India'),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{10,15}$/, 'Please enter a valid phone number.'),
  type: z.enum(['SHIPPING', 'BILLING']).default('SHIPPING'),
  isDefault: z.boolean().default(false),
})

export const adminLoginSchema = z.object({
  email,
  password: z.string().min(1, 'Please enter your password.'),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type AddressInput = z.infer<typeof addressSchema>
