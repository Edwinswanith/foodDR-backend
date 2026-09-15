/**
 * Auth-session support used by middleware/auth.ts's verifyJwt: JWT payload
 * decryption, device/session checks, and last-login tracking. Extracted from
 * the former authControllerService.ts (which held both this infrastructure
 * and the create/edit-user API business logic) — that business logic and its
 * route handlers (authController.ts) were removed; this file keeps only what
 * the auth middleware itself depends on to verify a request.
 */
import CryptoJS from "crypto-js";
import momentTZ from "moment-timezone";
import { ERROR_MESSAGE } from "../constants/index";
import { connectToMySQLDatabase } from "../../config/mysqlConnection";

class AuthSessionService {
  async decryptPayload(encryptedData: string, secretKey: string) {
    const decryptedData = CryptoJS.AES.decrypt(encryptedData, secretKey);
    return JSON.parse(decryptedData.toString(CryptoJS.enc.Utf8));
  }

  async getRecordSQL(query: any) {
    const pool = await connectToMySQLDatabase();
    const result = await pool.request().query(query);
    return result.recordset;
  }

  async fetchActiveDevice(payload: any) {
    return await this.getRecordSQL(
      `SELECT TOP 1 deviceId, status FROM Devices WHERE userId = ${payload.userId} AND deviceId = '${payload.deviceId}' ORDER BY createdAt DESC; `,
    );
  }

  // Function to check if the user is active on another device (wearable login only)
  async isUserActiveOnAnotherDevice(payload: any): Promise<boolean> {
    if (!payload.wearableLogin) return false;

    const deviceDetails = await this.fetchActiveDevice(payload);
    return deviceDetails?.length > 0 && deviceDetails[0].status === "inactive";
  }

  // The wms `Devices` model (wearable/smart-ring/smart-band session
  // tracking: deviceId/status/is_smart_ring/is_smart_band) has no equivalent
  // in the real fooddr schema — `db pull` against the live database found
  // no such table; the closest real table, `device_tokens`, is FCM push
  // tokens, a different concept entirely, so mapping onto it would be
  // guessing at semantics this checkout doesn't define. Both callers of this
  // method only reach it when `payload.device === 'mobile'`, which this
  // checkout's actual Bearer/web auth flow never sets (see auth.ts), so an
  // empty result is both honest (no device-session data exists to query)
  // and behaviorally inert on the currently-reachable path.
  async fetchLatestActiveMobileDevice(_userId: any): Promise<Array<{ deviceId: string; status: string }>> {
    return [];
  }

  // Mobile single-active-device check
  async isUserActiveOnAnotherMobileDevice(payload: any): Promise<boolean> {
    if (payload.device !== 'mobile') return false;
    if (!payload.deviceId) return false;

    const latestActiveDevice = await this.fetchLatestActiveMobileDevice(payload.userId);

    // No active device = logged out, block old token
    if (!latestActiveDevice || latestActiveDevice.length === 0) return true;

    // Different deviceId = logged in on another device, block
    if (latestActiveDevice[0].deviceId !== payload.deviceId) return true;

    // Same deviceId = allow
    return false;
  }

  // Check if user has any active mobile device at all. See
  // fetchLatestActiveMobileDevice's comment — the underlying `Devices`
  // concept doesn't exist in the real schema and this is only reachable for
  // `device === 'mobile'` tokens, which this checkout's actual auth flow
  // never issues.
  async hasNoActiveMobileDevice(userId: any): Promise<{ blocked: boolean; message?: string }> {
    const activeDevices = await this.fetchLatestActiveMobileDevice(userId);

    if (activeDevices.length === 0) {
      return { blocked: true, message: ERROR_MESSAGE.NO_ACTIVE_DEVICE };
    }

    return { blocked: false };
  }

  // Function to check if the invite code has expired (wearable login only)
  async isInviteCodeExpired(payload: any): Promise<boolean> {
    if (!payload.wearableLogin) return false;

    const todayUTC = momentTZ.utc();
    const userDetails: any = await this.getRecordSQL(
      `SELECT * FROM Users WHERE userId = '${payload.userId}'`,
    );

    if (userDetails.length === 0) {
      throw new Error("User not found");
    }

    const userRecord = userDetails[0];

    if (
      userRecord.inviteCodeExpire_utc &&
      todayUTC > momentTZ.utc(userRecord.inviteCodeExpire_utc)
    ) {
      const userTrainings = await this.getRecordSQL(
        `SELECT * FROM user_training_mapping WHERE userId = ${userRecord.userId}`,
      );
      return userTrainings.length === 0;
    }

    return false;
  }

  // Non-blocking last-login tracker, called from verifyJwt on every authenticated request.
  // `user_session_analytics` (per-day last-login tracking) has no equivalent
  // in the real fooddr schema — confirmed against the live DB's 19 real
  // tables, same category of gap as the `Devices`/`Logs` fictional models
  // fixed elsewhere in this file/logsService.ts. This is fire-and-forget,
  // best-effort telemetry with no consumer anywhere else in the app (nothing
  // reads it back), so — unlike the auth-blocking device checks, which had a
  // safe "no active device" default — there's no real behavior to preserve
  // here at all; a documented no-op is more honest than inventing a new
  // table/schema purely to keep a log line quiet.
  async trackLastLogin(_userId: number, _orgId?: number): Promise<void> {
    return;
  }
}

export default new AuthSessionService();
