export const ROLES = Object.freeze({
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  CASHIER: 'caja',
  WAITER: 'mesero',
  KITCHEN: 'cocina',
});

export const ROLE_LABELS = Object.freeze({
  [ROLES.ADMIN]: 'Administrador',
  [ROLES.SUPERVISOR]: 'Supervisor',
  [ROLES.CASHIER]: 'Caja',
  [ROLES.WAITER]: 'Mesero',
  [ROLES.KITCHEN]: 'Cocina',
});

export const VALID_ROLES = Object.freeze(Object.values(ROLES));

const PERMISSIONS = Object.freeze({
  cash_charge: [ROLES.ADMIN, ROLES.CASHIER],
  cash_open_close: [ROLES.ADMIN, ROLES.CASHIER],
  cash_movements: [ROLES.ADMIN, ROLES.CASHIER],
  payment_void: [ROLES.ADMIN, ROLES.SUPERVISOR],
  payment_refund: [ROLES.ADMIN, ROLES.SUPERVISOR],
  cash_reopen_closure: [ROLES.ADMIN],
  cash_edit_closure: [ROLES.ADMIN],
  order_delete_sent: [ROLES.ADMIN],
});

export function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

export function isValidRole(role) {
  return VALID_ROLES.includes(normalizeRole(role));
}

export function can(user, permission) {
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(normalizeRole(user?.rol));
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.user, permission)) {
      return res.status(403).json({ message: 'No tienes permiso para esta accion.' });
    }
    next();
  };
}
