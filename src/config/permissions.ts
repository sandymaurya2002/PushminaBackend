/**
 * Permission catalogue.
 *
 * Every admin route declares the permission it requires. Roles are just named
 * bundles of these keys, so adding a new capability means adding one constant
 * here and ticking a box in Admin → Roles — never editing route code.
 */

export const PERMISSION_GROUPS = {
  Dashboard: ['dashboard.view'],

  Products: [
    'products.view',
    'products.create',
    'products.update',
    'products.delete',
    'products.publish',
    'products.merchandise', // featured / trending / new arrival flags and ordering
  ],

  Inventory: ['inventory.view', 'inventory.adjust'],

  Taxonomy: [
    'taxonomy.view',
    'taxonomy.create',
    'taxonomy.update',
    'taxonomy.delete',
  ],

  Categories: [
    'categories.view',
    'categories.create',
    'categories.update',
    'categories.delete',
  ],

  Collections: [
    'collections.view',
    'collections.create',
    'collections.update',
    'collections.delete',
  ],

  Discounts: [
    'discounts.view',
    'discounts.create',
    'discounts.update',
    'discounts.delete',
  ],

  Orders: [
    'orders.view',
    'orders.update',
    'orders.cancel',
    'orders.fulfil',
    'orders.export',
  ],

  Payments: ['payments.view', 'payments.export'],

  Refunds: ['refunds.view', 'refunds.create', 'refunds.approve', 'refunds.reject'],

  Customers: [
    'customers.view',
    'customers.update',
    'customers.block',
    'customers.delete',
    'customers.export',
  ],

  Reviews: ['reviews.view', 'reviews.moderate', 'reviews.delete'],

  Content: [
    'content.view',
    'content.create',
    'content.update',
    'content.delete',
    'content.publish',
  ],

  Blog: ['blog.view', 'blog.create', 'blog.update', 'blog.delete', 'blog.publish'],

  Banners: ['banners.view', 'banners.create', 'banners.update', 'banners.delete'],

  Navigation: ['navigation.view', 'navigation.manage'],

  Seo: ['seo.view', 'seo.update'],

  Media: ['media.view', 'media.upload', 'media.delete'],

  Notifications: [
    'notifications.view',
    'notifications.send',
    'notifications.delete',
  ],

  Contact: ['contact.view', 'contact.update', 'contact.delete'],

  Newsletter: ['newsletter.view', 'newsletter.export', 'newsletter.delete'],

  Settings: ['settings.view', 'settings.update'],

  AdminUsers: [
    'admins.view',
    'admins.create',
    'admins.update',
    'admins.delete',
  ],

  Roles: ['roles.view', 'roles.create', 'roles.update', 'roles.delete'],

  Audit: ['audit.view'],
} as const

export type PermissionGroup = keyof typeof PERMISSION_GROUPS

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSION_GROUPS).flat()

/** Human labels for the role editor, derived so they can never drift. */
export function permissionLabel(key: string): string {
  const [, action = ''] = key.split('.')
  const words = action.replace(/([A-Z])/g, ' $1')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function groupForPermission(key: string): string {
  for (const [group, keys] of Object.entries(PERMISSION_GROUPS)) {
    if ((keys as readonly string[]).includes(key)) return group
  }
  return 'Other'
}

/* ------------------------------------------------------------------ *
 * Built-in roles
 * ------------------------------------------------------------------ */

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'super-admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  EDITOR: 'editor',
  SUPPORT: 'support',
} as const

export const ROLE_DEFINITIONS: Array<{
  name: string
  slug: string
  description: string
  permissions: string[]
}> = [
  {
    name: 'Super Admin',
    slug: SYSTEM_ROLES.SUPER_ADMIN,
    description: 'Unrestricted access, including admin users, roles and settings.',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Admin',
    slug: SYSTEM_ROLES.ADMIN,
    description: 'Full store operations. Cannot manage admin users or roles.',
    permissions: ALL_PERMISSIONS.filter(
      (key) => !key.startsWith('admins.') && !key.startsWith('roles.'),
    ),
  },
  {
    name: 'Store Manager',
    slug: SYSTEM_ROLES.MANAGER,
    description: 'Catalogue, orders, payments and customers. No settings or SEO.',
    permissions: ALL_PERMISSIONS.filter((key) =>
      [
        'dashboard.',
        'products.',
        'inventory.',
        'taxonomy.',
        'categories.',
        'collections.',
        'discounts.',
        'orders.',
        'payments.',
        'refunds.',
        'customers.',
        'reviews.',
        'media.',
        'notifications.',
        'contact.',
      ].some((prefix) => key.startsWith(prefix)),
    ),
  },
  {
    name: 'Content Editor',
    slug: SYSTEM_ROLES.EDITOR,
    description: 'Blog, pages, banners, navigation, SEO and media only.',
    permissions: ALL_PERMISSIONS.filter((key) =>
      [
        'dashboard.view',
        'content.',
        'blog.',
        'banners.',
        'navigation.',
        'seo.',
        'media.',
        'products.view',
        'collections.view',
      ].some((prefix) => key.startsWith(prefix)),
    ),
  },
  {
    name: 'Customer Support',
    slug: SYSTEM_ROLES.SUPPORT,
    description: 'Read orders and customers, handle contact forms and refunds requests.',
    permissions: [
      'dashboard.view',
      'orders.view',
      'orders.update',
      'payments.view',
      'refunds.view',
      'refunds.create',
      'customers.view',
      'reviews.view',
      'reviews.moderate',
      'contact.view',
      'contact.update',
      'notifications.view',
      'products.view',
    ],
  },
]
