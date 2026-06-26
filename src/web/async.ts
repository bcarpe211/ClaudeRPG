import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async Express handler so any thrown error / rejected promise is
 * forwarded to Express's error middleware instead of becoming an unhandled
 * rejection (which would crash the process on Express 4 + modern Node).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
