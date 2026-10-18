import { Router, Request, Response } from 'express';
import { GoogleWorkspaceClient } from '../../integrations/google/client.js';
import { SlackClient } from '../../integrations/slack/client.js';

export function createHealthRouter(googleClient: GoogleWorkspaceClient, slackClient: SlackClient): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '5.0.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      googleConnected: googleClient.isConnected(),
      slackConfigured: slackClient.isConfigured(),
      timestamp: new Date().toISOString()
    });
  });

  return router;
}
