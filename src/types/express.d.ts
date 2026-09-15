import type { UserStatus } from '@prisma/client'

/**
 * Request augmentation.
 *
 * `user` is a signed-in customer, `admin` is a signed-in staff member. They are
 * deliberately separate fields on separate token audiences, so a customer token
 * can never satisfy an admin guard even if one were forged with the wrong secret.
 */
declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string
      email: string
      firstName: string
      lastName: string
      status: UserStatus
    }

    interface AuthenticatedAdmin {
      id: string
      email: string
      name: string
      roleId: string
      roleSlug: string
      permissions: string[]
    }

    interface Request {
      user?: AuthenticatedUser
      admin?: AuthenticatedAdmin
      /** Guest cart identity, from the pushmina_sid cookie. */
      sessionId?: string
      requestId?: string
    }
  }
}

export {}
