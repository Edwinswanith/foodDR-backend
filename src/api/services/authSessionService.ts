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

  // The wms `Devices` model has no equivalent in the real fooddr schema.
  // `device_tokens` stores FCM push tokens, not authenticated sessions, so it
  // cannot safely stand in for a single-active-device check.
  async fetchLatestActiveMobileDevice(_userId: any): Promise<Array<{ deviceId: string; status: string }>> {
    return [];
  }

  // This checkout has no authoritative mobile-session store. Do not reject a
  // valid partner token merely because that unavailable store has no record.
  async isUserActiveOnAnotherMobileDevice(payload: any): Promise<boolean> {
    void payload;
    return false;
  }

  // There is no authoritative active-device table in this schema, so this
  // check must not turn every valid mobile token into a false 422 response.
  async hasNoActiveMobileDevice(userId: any): Promise<{ blocked: boolean; message?: string }> {
    void userId;
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
  async trackLastLogin(_userId: string | number, _orgId?: string | number): Promise<void> {
    return;
  }
}

export default new AuthSessionService();
