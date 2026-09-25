export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Ingen gyldig session') => new HttpError(401, msg);
export const forbidden = (msg = 'Ingen adgang') => new HttpError(403, msg);
export const notFound = (msg = 'Findes ikke') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);
export const tooMany = (msg = 'For mange forsøg – vent lidt', details) => new HttpError(429, msg, details);

/** Wraps an async route handler so rejections reach the Express error handler. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
