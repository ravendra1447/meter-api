const crypto = require('crypto');
const pool = require('../config/database');

const TOKENABLE_TYPE = 'App\\Models\\User';

function hashToken(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function generatePlainToken() {
  return crypto.randomBytes(40).toString('hex').slice(0, 40);
}

async function createToken(userId, name = 'auth-token') {
  const plain = generatePlainToken();
  const hashed = hashToken(plain);
  const [result] = await pool.query(
    `INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [TOKENABLE_TYPE, userId, name, hashed, '*']
  );
  return `${result.insertId}|${plain}`;
}

async function revokeAllTokens(userId) {
  await pool.query(
    'DELETE FROM personal_access_tokens WHERE tokenable_type = ? AND tokenable_id = ?',
    [TOKENABLE_TYPE, userId]
  );
}

async function revokeToken(tokenId) {
  await pool.query('DELETE FROM personal_access_tokens WHERE id = ?', [tokenId]);
}

async function findUserByBearer(bearer) {
  if (!bearer || !bearer.startsWith('Bearer ')) return null;
  const raw = bearer.slice(7).trim();
  const pipe = raw.indexOf('|');
  if (pipe === -1) return null;
  const id = parseInt(raw.slice(0, pipe), 10);
  const plain = raw.slice(pipe + 1);
  if (!id || !plain) return null;
  const hashed = hashToken(plain);
  const [rows] = await pool.query(
    `SELECT pat.id AS token_id, u.* FROM personal_access_tokens pat
     INNER JOIN users u ON u.id = pat.tokenable_id
     WHERE pat.id = ? AND pat.token = ? AND pat.tokenable_type = ?
     LIMIT 1`,
    [id, hashed, TOKENABLE_TYPE]
  );
  if (!rows.length) return null;
  const user = rows[0];
  user.token_id = user.token_id;
  await pool.query('UPDATE personal_access_tokens SET last_used_at = NOW() WHERE id = ?', [id]);
  return user;
}

module.exports = {
  createToken,
  revokeAllTokens,
  revokeToken,
  findUserByBearer,
  TOKENABLE_TYPE,
};
