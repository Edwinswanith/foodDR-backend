import { NextFunction, Request, Response } from "express";
import Responser from "../core/responser";
import { d1 } from "../utils/connection";
import { d2 } from "../utils/exception";

const bcrypt = require("bcrypt");
import { EXCLUDE_APIS } from "../constants/index";
import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";

class CustomAuth {

  /* front end d1+d2 encrypt and send here is compare the encrypted string with actual string. with salt 10 */
  async customAuthMiddleware(req: Request, res: Response, next: NextFunction) {

    if (EXCLUDE_APIS.includes(req.path)) {
      try {
        const token: any = req.headers.token;
        if (!token) {
          throw new Error("Forbidden");
        }
        const orgString = d1 + d2;
        if (token == "") {
          let err: any = {};
          err.statusCode = 403;
          err.message = "";
          err.data = {};
          return Responser.error(res, false, err);
        }

        bcrypt.compare(orgString, token, function (err: any, result: any) {
          if (err) {
            err.message = err?.response?.data?.message;
            err.statusCode = 403;
            Responser.error(res, false, err);
          } else if (result) {
            next();
          } else {
            let err: any = {};
            err.statusCode = 403;
            err.message = "";
            err.data = {};
            return Responser.error(res, false, err);
          }
        });
      } catch (err: any) {
        err.message = "";
        err.statusCode = 403;
        Responser.error(res, false, err);
      }
    } else {
      next()
    }

  }

}
export default new CustomAuth();
