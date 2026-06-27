const { findUserByBearer } = require('../utils/sanctum');
const { fail } = require('../utils/response');
const { activeTenantAssignment } = require('../helpers/userHelpers');

async function authenticate(req, res, next) {
  try {
    const user = await findUserByBearer(req.headers.authorization || '');
    if (!user) return fail(res, 'Unauthenticated.', 401);
    if (!user.is_active) return fail(res, 'Your account is inactive.', 403);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return fail(res, 'Forbidden.', 403);
    }
    next();
  };
}

function requireOwnerAccess(req, res, next) {
  if (!req.user) return fail(res, 'Unauthenticated.', 401);
  if (req.user.role === 'owner' || !!req.user.is_property_owner) {
    return next();
  }
  return fail(res, 'Only property owners can access this resource.', 403);
}

async function requireTenantAccess(req, res, next) {
  if (!req.user) return fail(res, 'Unauthenticated.', 401);
  if (req.user.role === 'master') {
    return fail(res, 'Only tenants can access this resource.', 403);
  }
  if (req.user.role === 'tenant') {
    return next();
  }
  const assignment = await activeTenantAssignment(req.user.id);
  if (assignment) {
    return next();
  }
  return fail(res, 'Only tenants can access this resource.', 403);
}

module.exports = { authenticate, requireRole, requireOwnerAccess, requireTenantAccess };
