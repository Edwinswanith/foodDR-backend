import AppError from "../core/error-handler";

class ValidationErrorHandler {
  static handlerError(
    errors: any,
    errMsg: string,
    statusCode: number = 400
  ) {
    if (errors.length != 0) {
      throw new AppError(errMsg, errors, statusCode);
    }
  }
}

export default ValidationErrorHandler;
