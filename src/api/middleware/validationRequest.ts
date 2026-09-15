import { NextFunction, Request, Response } from "express";
import { ROUTE, routePath } from '../constants/index';
import Responser from "../core/responser";
import ValidationErrorHandler from './validation-error-handler';
import { nutritionProfileSchema } from '../validations/nutrition.validation';

const Ajv = require("ajv").default
const ajv = new Ajv({ allErrors: true });
require("ajv-errors")(ajv);

class ValidationRequest {

    async validation(req: Request, res: Response, next: NextFunction) {
        let statusCode = 400;
        let body;

        try {
            body = req.body;

            const routeValidationMap = new Map<string, any>([
                [routePath(ROUTE.GENERATE_NUTRITION_PLAN), nutritionProfileSchema],
            ]);

            /** ✅ Normalize URL for param routes */
            const cleanUrl = req.route?.path || req.path;
            let validateReq = routeValidationMap.get(cleanUrl);

            /** ✅ GET routes — query-param only, no body to validate */
            const routesThatSkipValidation = new Set([
                routePath(ROUTE.GET_WEIGHT_HISTORY),
                routePath(ROUTE.GET_NUTRITION_TIMELINE),
            ]);

            if (routesThatSkipValidation.has(cleanUrl)) {
                return next();
            }

            /** ✅ Continue if schema doesn't exist */
            if (!validateReq) {
                return next();
            }

            ajv.addFormat('custom-date-time', (dt: any) => !isNaN(Date.parse(dt)));

            const validate = ajv.compile(validateReq);

            if (validate(req.body)) {
                req.body = body;
                return next();
            } else {
                const error = validate.errors;
                const errMsg = error.map((err: any) => err.message).join('; ');
                return ValidationErrorHandler.handlerError(error, errMsg, statusCode);
            }

        } catch (error) {
            return Responser.error(res, false, error);
        }
    }
}

export default new ValidationRequest();
