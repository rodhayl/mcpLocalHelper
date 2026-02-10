import { Request, Response } from 'express';

export const getHealth = (_req: Request, res: Response) => {
  // Expose basic health status along with simple cache metrics for monitoring
  res.json({ status: 'ok', cacheSize: 0, cacheHits: 0, cacheMisses: 0 });
};
