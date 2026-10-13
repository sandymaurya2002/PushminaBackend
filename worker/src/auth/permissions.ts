/**
 * Permission catalogue, ported from the Express app. Roles are code-defined and
 * stored per admin in users.admin_role; Super Admin bypasses every check.
 */

export const PERMISSION_GROUPS = {
  Dashboard: ["dashboard.view"],
  Products: ["products.view", "products.create", "products.update", "products.delete", "products.publish", "products.merchandise"],
  Inventory: ["inventory.view", "inventory.adjust"],
  Taxonomy: ["taxonomy.view", "taxonomy.create", "taxonomy.update", "taxonomy.delete"],
  Categories: ["categories.view", "categories.create", "categories.update", "categories.delete"],
  Collections: ["collections.view", "collections.create", "collections.update", "collections.delete"],
  Orders: ["orders.view", "orders.update", "orders.cancel", "orders.fulfil", "orders.export"],
  Customers: ["customers.view", "customers.update", "customers.block", "customers.delete", "customers.export"],
  Media: ["media.view", "media.upload", "media.delete"],
  AdminUsers: ["admins.view", "admins.create", "admins.update", "admins.delete"],
  Roles: ["roles.view"],
  Audit: ["audit.view"],
} as const;

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSION_GROUPS).flat();

export const ADMIN_ROLE_KEYS = ["SUPER_ADMIN", "ADMIN", "MANAGER", "EDITOR", "SUPPORT"] as const;
export type AdminRoleKey = (typeof ADMIN_ROLE_KEYS)[number];

interface RoleDefinition {
  key: AdminRoleKey;
  slug: string;
  name: string;
  description: string;
  permissions: string[];
}

const withPrefixes = (...prefixes: string[]) => ALL_PERMISSIONS.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));

export const ROLES: Record<AdminRoleKey, RoleDefinition> = {
  SUPER_ADMIN: {
    key: "SUPER_ADMIN",
    slug: "super-admin",
    name: "Super Admin",
    description: "Unrestricted access, including admin users and roles.",
    permissions: ALL_PERMISSIONS,
  },
  ADMIN: {
    key: "ADMIN",
    slug: "admin",
    name: "Admin",
    description: "Full store operations. Cannot manage admin users.",
    permissions: ALL_PERMISSIONS.filter((key) => !key.startsWith("admins.")),
  },
  MANAGER: {
    key: "MANAGER",
    slug: "manager",
    name: "Store Manager",
    description: "Catalogue, inventory, orders, customers and media.",
    permissions: withPrefixes("dashboard.", "products.", "inventory.", "taxonomy.", "categories.", "collections.", "orders.", "customers.", "media."),
  },
  EDITOR: {
    key: "EDITOR",
    slug: "editor",
    name: "Content Editor",
    description: "Media plus read access to products and collections.",
    permissions: withPrefixes("dashboard.view", "media.", "products.view", "collections.view"),
  },
  SUPPORT: {
    key: "SUPPORT",
    slug: "support",
    name: "Customer Support",
    description: "Read orders and customers, update order notes and status.",
    permissions: ["dashboard.view", "orders.view", "orders.update", "customers.view", "products.view"],
  },
};

export function roleBySlug(slug: string): RoleDefinition | undefined {
  return Object.values(ROLES).find((role) => role.slug === slug || role.key === slug);
}

export function permissionsFor(role: AdminRoleKey | null | undefined): Set<string> {
  return new Set(role ? ROLES[role]?.permissions ?? [] : []);
}

export function hasPermission(role: AdminRoleKey | null | undefined, permission: string): boolean {
  if (role === "SUPER_ADMIN") return true;
  return permissionsFor(role).has(permission);
}

export function permissionLabel(key: string): string {
  const action = key.split(".")[1] ?? "";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export function permissionCatalogue() {
  return Object.entries(PERMISSION_GROUPS).flatMap(([group, keys]) =>
    keys.map((key) => ({ id: key, key, label: permissionLabel(key), group })),
  );
}
