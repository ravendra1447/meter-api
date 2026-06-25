const { findUserByBearer } = require('../utils/sanctum');
const { fail } = require('../utils/response');

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

module.exports = { authenticate, requireRole };
