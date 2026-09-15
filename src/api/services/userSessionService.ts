/**
 * LOCAL DEV STUB. Only used by middleware/auth.ts's generateJwt/
 * generateRefreshToken (the login-issuing side) — not called by verifyJwt,
 * which is the only auth.ts method the nutrition routes actually exercise.
 * A safe no-op rather than a guess at the real session-record shape.
 */
class UserSessionService {
  async addRecord(_data: Record<string, any>): Promise<void> {
    // no-op — see file header.
  }
}

export default new UserSessionService();
