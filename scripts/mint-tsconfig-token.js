/**
 * Dev-only: mint a token for this checkout's auth scheme (a JWT wrapping a
 * CryptoJS-AES-encrypted payload — see src/api/middleware/auth.ts). This is
 * NOT the same scheme as backend-node's plain {sub,type,exp} JWT; tokens
 * from one server are not valid on the other.
 *
 * Usage: node scripts/mint-tsconfig-token.js [userId]   (default userId=1)
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');

const jwtSecret = process.env.JWT_SECRET_KEY || 'dev-local-jwt-secret-change-me';
const cryptoSecret = process.env.CRYPTO_PAYLOAD_SECRET_KEY || 'dev-local-payload-secret-change-me';
// userId is a string (the real user_nutrition_profiles.id is a UUID) — do
// NOT Number() it, that would silently produce NaN for any real id.
const userId = process.argv[2] || '1';
const payload = { userId, orgId: 1, device: 'web' };
const data = CryptoJS.AES.encrypt(JSON.stringify(payload), cryptoSecret).toString();

console.log(jwt.sign({ data, exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret, {}));
