import type { Logger } from 'pino';
import type { AdminIdentity } from './services/authService.js';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      log: Logger;
      admin?: AdminIdentity;
      sessionToken?: string;
    }
  }
}

export {};
