import { NextFunction, Request, Response } from "express";
import Responser from "../core/responser";
import jwt from 'jsonwebtoken';
import CryptoJS from 'crypto-js';
import config from '../../config/config';
import { EXCLUDE_APIS, SUCCESS_MESSAGES, ERROR_MESSAGE } from "../constants";
import authControllerService from "../services/authSessionService";
import userSessionService from "../services/userSessionService";
import AppError from "../core/error-handler";
import commonService from "../services/commonService";
import { includes } from "lodash";


declare module 'express-serve-static-core' {
    interface Request {
        payload?: any;
    }
}

class CustomError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
    }
}



const EXCLUDE_MOBILE_CHECK_APIS: string[] = [];

const EXCLUDE_TRACK_LOGIN_APIS = [
    '/device/smart-ring-data-sync',
    // add other high-frequency endpoints here if needed
];

const EXCLUDE_MOBILE_CHECK_APIS_FOR_NO_DEVICE_ACTIVE: string[] = [];


class Authentication {
    async generateJwt(payload: any): Promise<string> {
        try {
            // Encrypt payload
            const str = JSON.stringify(payload);
            const data = CryptoJS.AES.encrypt(str, config.cryptoPayloadSecretKey).toString();
            const payloadData: any = { data };
            let expVal: any = ''

            // Check if payload contains exp as Unix timestamp
            if (payload.exp) {
                payloadData.exp = payload.exp;
            } else {
                // If exp is not provided, default to 24h expiration
                payloadData.exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
                // payloadData.exp = Math.floor(Date.now() / 1000) + 5 * 60;
            }

            // create user session record
            expVal = Math.floor(Date.now() / 1000) + 24 * 60 * 60
            // expVal = Math.floor(Date.now() / 1000) + 5 * 60;
            const userSessionData: any = { uuid: expVal.toString() }
            await userSessionService.addRecord(userSessionData)


            // Generate JWT
            return new Promise((resolve, reject) => {
                jwt.sign(payloadData, config.jwtSecretKey, {}, (err, token) => {
                    if (err) {
                        reject(new Error(err.message || 'JWT signing failed'));
                    } else {
                        resolve(token as string);
                    }
                });
            });
        } catch (error: any) {
            throw new Error(`Error generating token: ${error.message}`);
        }
    }

    async generateRefreshToken(payload: any): Promise<string> {
        try {
            const str = JSON.stringify(payload);
            const data = CryptoJS.AES.encrypt(str, config.cryptoPayloadSecretKey).toString();
            const payloadData: any = {
                data,
                exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 // 30 days
            };

            return new Promise((resolve, reject) => {
                jwt.sign(payloadData, config.jwtSecretKey, {}, (err, token) => {
                    if (err) reject(new Error(err.message || 'Refresh JWT signing failed'));
                    else resolve(token as string);
                });
            });
        } catch (error: any) {
            throw new Error(`Error generating refresh token: ${error.message}`);
        }
    }



    async verifyJwt(req: Request, res: Response, next: NextFunction) {
        try {
            if (req.headers['azurelogin']) {

                const authHeader: any = req.headers['authorization'];
                const token = authHeader.split(' ')[1];

                if (token) {
                    try {
                        // Decode the token payload (without verifying it)
                        const decodedToken = jwt.decode(token);

                        // Optionally, verify the token if you need to ensure its validity
                        // const verifiedToken = jwt.verify(token, azureSecretKey);

                        // Add the decoded token or verified data to the request for further use
                        req.body.azureDecodedToken = decodedToken;

                        next();
                    } catch (error: any) {
                        res.status(401).json({ message: 'Invalid token' });
                    }
                } else {
                    res.status(401).json({ message: 'Authorization token missing' });
                }
            } else {
                const token = req.headers.authorization?.startsWith('Bearer ')
                    ? req.headers.authorization.split(' ')[1]
                    : null;

                if (!token) {
                    // throw new Error("Forbidden");
                    return res.status(401).json({ message: 'Forbidden' });
                }

                if (EXCLUDE_APIS.includes(req.path)) {
                    next()
                    return
                }
                if (!token) {
                    return res.status(401).json({ message: 'Forbidden' });
                }

                jwt.verify(token, config.jwtSecretKey, async (err: any, decoded: any) => {
                    if (err) {
                        return res.status(401).json({ message: 'Forbidden' });
                    }

                    try {
                        const originalPayload: any = await authControllerService.decryptPayload(decoded.data, config.cryptoPayloadSecretKey);


                        if (originalPayload.tokenType === 'refresh') {
                            return res.status(401).json({ message: 'Invalid token type' });
                        }

                        // Wearable device check only -- only for smart watch
                        if (await authControllerService.isUserActiveOnAnotherDevice(originalPayload)) {
                            return res.status(422).json({ message: ERROR_MESSAGE.USER_ACTIVE_IN_ANOTHER_DEVICE });
                        }

                        // // Mobile device check only (skipped for web)
                        // if (await authControllerService.isUserActiveOnAnotherMobileDevice(originalPayload)) {
                        //     return res.status(422).json({ message: 'User is active in another device.' });
                        // }

                        if (!EXCLUDE_MOBILE_CHECK_APIS.includes(req.path)) {
                            // 1️⃣ Check if any active mobile device exists at all
                            if (!EXCLUDE_MOBILE_CHECK_APIS_FOR_NO_DEVICE_ACTIVE.includes(req.path) && originalPayload.device === 'mobile') {
                                const deviceCheck = await authControllerService.hasNoActiveMobileDevice(originalPayload.userId);
                                if (deviceCheck.blocked) {
                                    return res.status(422).json({ message: deviceCheck.message });
                                }
                            }

                            if (await authControllerService.isUserActiveOnAnotherMobileDevice(originalPayload)) {
                                return res.status(422).json({ message: ERROR_MESSAGE.USER_ACTIVE_IN_ANOTHER_DEVICE });
                            }

                        }

                        //  -- only for smart watch
                        if (await authControllerService.isInviteCodeExpired(originalPayload)) {
                            return res.status(422).json({ message: 'Invite code is expired, login again' });
                        }


                        // if (await authControllerService.isAuthUserIdRequired(req.path)) {
                        req.body.userId = originalPayload?.userId || "";
                        // }
                        req.body.authUserId = originalPayload?.userId || "";
                        req.body.orgId = originalPayload?.orgId || "";

                        // ── Track last login (non-blocking) ────────────────────────────

                        if (!EXCLUDE_TRACK_LOGIN_APIS.includes(req.path)) {
                            authControllerService.trackLastLogin(originalPayload.userId, originalPayload.orgId);
                        }

                        next();
                    } catch (error) {
                        Responser.error(res, false, error);
                    }

                })
            }

        } catch (error) {
            Responser.error(res, false, error);

        }
    }



    async decodeToken(req: Request, res: Response, next: NextFunction) {
        try {

            const token = req.headers.authorization?.startsWith('Bearer ')
                ? req.headers.authorization.split(' ')[1]
                : null;

            if (!token) {
                throw new Error("Forbidden");
            }

            if (EXCLUDE_APIS.includes(req.path)) {
                next()
                return
            }
            if (!token) {
                throw new Error("Forbidden");
            }

            jwt.verify(token, config.jwtSecretKey, async (err: any, decoded: any) => {
                if (err) {
                    return res.status(401).json({ message: 'Forbidden' });
                }

                try {
                    const originalPayload: any = await authControllerService.decryptPayload(decoded.data, config.cryptoPayloadSecretKey);

                    req.body.userId = originalPayload?.userId || "";
                    req.body.authUserId = originalPayload?.userId || "";
                    req.body.orgId = originalPayload?.orgId || "";
                    return Responser.success(res, true, SUCCESS_MESSAGES.TOKEN_VALIDATED_SUCCESSFULLY, originalPayload, 200);

                } catch (error) {
                    Responser.error(res, false, error);
                }

            })

        } catch (error) {
            Responser.error(res, false, error);

        }
    }


    // async verifyRbac(req: Request, res: Response, next: NextFunction) {
    //     try {
    //         const token: any = req.headers.authorization?.split(' ')[1]
    //         if (!token) {
    //             throw new Error("Forbidden");
    //         }

    //         jwt.verify(token, config.jwtSecretKey, async (err: any, decoded: any) => {
    //             if (err) {
    //                 return res.status(401).json({ message: 'Forbidden' });
    //             }


    //             // Decrypt payload
    //             const originalPayload: any = await authControllerService.decryptPayload(decoded.data, config.cryptoPayloadSecretKey);

    //             // Fetch user details
    //             const userDetails: any = await authControllerService.getRecordSQL(
    //                 `SELECT * FROM Users WHERE userId = '${originalPayload.userId}'`

    //             );


    //             if (userDetails.length == 0) {
    //                 return res.status(404).json({ message: 'User not found' });
    //             }

    //             /** verify  role access of user start */


    //             // console.log('req.body>>', req.body)
    //             const rbacStatus: boolean = await rbacService.verifyRoleBasedAccess(req.body, userDetails[0], 1)
    //             if (!rbacStatus) {
    //                 // console.log('error>>', req.body)
    //                 let errMsg = req?.body?.module == 'WMS Wearable' || req?.body?.module == 'WMS Mobile' ? ERROR_MESSAGE.ROLE_BASED_ACCESS_UNAUTHORISED_OTHER : ERROR_MESSAGE.ROLE_BASED_ACCESS_UNAUTHORISED
    //                 return res.status(403).json({ status: false, message: errMsg || ERROR_MESSAGE.ROLE_BASED_ACCESS_UNAUTHORISED, data: [] });

    //             }
    //             //  req.body.userId = originalPayload.userId ?? ''
    //             req.body.userId = EXCLUDE_WEARABLE_APIS.includes(req.path) ? req?.body?.userId : originalPayload?.userId || "";

    //             /** verify  role access of user end */

    //             // return 

    //             next();
    //         });

    //     } catch (error) {
    //         console.log("error Log")
    //         console.log(error, '-<, error...')
    //         Responser.error(res, false, error);
    //     }

    // }


    async verifyRoleBasedAccess(payload: any, userDetails: any) {
        const device: string = (payload.device || 'mobile').toLowerCase().trim();
        const loginModule = device === 'web' ? 'web login' : 'mobile login';

        const userRole = await commonService.getFromTable('Roles', { id: userDetails.role_id, isDeleted: false });

        if (!userRole) {
            throw new AppError(ERROR_MESSAGE.UNAUTHORIZED, [], 403);
        }

        const roleMappings = await commonService.getManyFromTable(
            'role_Module_Mapping',
            { role_id: userRole.id, isDeleted: false },
            {
                include: {
                    Modules: {
                        select: { id: true, name: true }
                    }
                }
            }
        );

        if (!roleMappings.length) {
            throw new AppError(ERROR_MESSAGE.UNAUTHORIZED, [], 403);
        }

        const accessibleModules: string[] = roleMappings
            .map((m: any) => m.Modules?.name?.toLowerCase().trim())
            .filter(Boolean);

        const hasLoginAccess = accessibleModules.includes(loginModule);

        if (!hasLoginAccess) {
            throw new AppError(ERROR_MESSAGE.UNAUTHORIZED, [], 403);
        }

        // Build rbacData list
        const rbacData = roleMappings.map((m: any) => ({
            id: m.id,
            role_id: m.role_id,
            module_id: m.module_id,
            isDeleted: m.isDeleted,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
            role_name: userRole.name,
            module_name: m.Modules?.name || ''
        }));

        // Build accessList (module names array)
        const accessList: string[] = roleMappings
            .map((m: any) => m.Modules?.name)
            .filter(Boolean);

        return {
            accessStatus: true,
            role: userRole.name,
            rbacData,
            accessList,
            // for mobile, still return but frontend can ignore
            modules: device === 'web' ? rbacData : []
        };
    }


}

export default new Authentication();
