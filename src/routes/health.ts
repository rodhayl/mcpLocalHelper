import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';

const router = Router();
router.get('/health', getHealth);
// Re-export as named export to satisfy imports like: import { healthRouter } from './routes/health'
export { router as healthRouter };
export default router;
