import express, { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import type { UnifiedAgentRunner } from '../../agent/runner.js';
import type { ModelRouter } from '../../models/model-router.js';
import type { ActionLedgerRepository } from '../../storage/action-ledger.js';
import type { ToolDispatcher } from '../../governance/dispatcher.js';
import type { SlackClient } from '../../integrations/slack/client.js';
import {
  resolveInteractiveSlackGrant,
  MANAGEMENT_TOOL_NAMES,
  DOCUMENT_TOOL_NAMES
} from '../../integrations/slack/coworker.js';

export interface VoiceRouterDependencies {
  runner: UnifiedAgentRunner;
  modelRouter: ModelRouter;
  ledgerRepo: ActionLedgerRepository;
  dispatcher: ToolDispatcher;
  slackClient?: SlackClient;
}

export function createVoiceRouter(runtime: VoiceRouterDependencies): Router {
  const router = Router();
  router.use(express.json({ limit: '25mb' }));

  const sessions = new Map<string, Array<{ role: 'user' | 'model'; parts: any[] }>>();
  const { runner, modelRouter, ledgerRepo, dispatcher, slackClient } = runtime;

  // GET /api/voice/status - Voice & Live Capabilities Metadata
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      flashModel: modelRouter.flashModel,
      reasoningModel: modelRouter.reasoningModel,
      transcribeModel: modelRouter.transcribeModel,
      ttsModel: modelRouter.ttsModel,
      liveModel: modelRouter.liveModel,
      activeSessions: sessions.size
    });
  });

  // POST /api/voice/turn - Interactive Voice Turn
  router.post('/turn', async (req: Request, res: Response) => {
    const { audioBase64, mimeType, text, sessionId: providedSessionId, speakReply, postToSlack } = req.body || {};

    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasAudio = typeof audioBase64 === 'string' && audioBase64.trim().length > 0;

    if (!hasText && !hasAudio) {
      res.status(400).json({ ok: false, error: 'Either text or audioBase64 must be provided' });
      return;
    }

    const sessionId = (typeof providedSessionId === 'string' && providedSessionId.trim())
      ? providedSessionId.trim()
      : `voice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    let transcript = '';
    if (hasAudio && !hasText) {
      try {
        const transcribeRes = await modelRouter.transcribeAudio({
          audioBase64: audioBase64.trim(),
          mimeType: mimeType || 'audio/mp4',
          source: 'voice_turn'
        });
        transcript = transcribeRes.text;
      } catch (err: any) {
        res.status(500).json({ ok: false, error: `Audio transcription failed: ${err.message || err}` });
        return;
      }
    } else if (hasText) {
      transcript = text.trim();
    }

    if (!transcript) {
      res.status(400).json({ ok: false, error: 'Could not extract valid spoken or written text from input' });
      return;
    }

    let conversationHistory = sessions.get(sessionId) || [];

    const allTools = dispatcher.getDeclaredTools().map(t => t.name);
    const resolved = resolveInteractiveSlackGrant({
      userText: transcript,
      conversationHistory,
      allAvailableTools: allTools
    });
    for (const name of MANAGEMENT_TOOL_NAMES) {
      if (allTools.includes(name)) {
        resolved.add(name);
      }
    }
    const grantedTools = Array.from(resolved);

    const stagedBefore = new Set(ledgerRepo.listStaged().map(a => a.id));

    try {
      const runResult = await runner.run({
        trigger: 'manual',
        instruction: transcript,
        conversationHistory,
        isInteractive: true,
        toolGrant: {
          allowedToolNames: resolved,
          allowConsequential: true
        }
      });

      const replyText = runResult.output.slackMessage || runResult.output.coworkerHeadline || runResult.output.summary || '';

      conversationHistory.push({ role: 'user', parts: [{ text: transcript }] });
      conversationHistory.push({ role: 'model', parts: [{ text: replyText }] });
      if (conversationHistory.length > 10) {
        conversationHistory = conversationHistory.slice(-10);
      }
      sessions.set(sessionId, conversationHistory);

      const stagedAfter = ledgerRepo.listStaged();
      const stagedActionsCount = stagedAfter.filter(a => !stagedBefore.has(a.id)).length;

      let ttsResult: { audioBase64: string; mimeType: string } | undefined;
      if (speakReply !== false && replyText.trim()) {
        ttsResult = await modelRouter.synthesizeSpeech({
          text: replyText,
          source: 'voice_turn'
        });
      }

      if (postToSlack === true && slackClient?.isConfigured() && replyText.trim()) {
        try {
          await slackClient.postMessage({ text: replyText });
        } catch (err: any) {
          console.warn(`[VoiceRouter] Failed to post reply to Slack: ${err?.message || err}`);
        }
      }

      res.json({
        ok: true,
        sessionId,
        runId: runResult.runId,
        transcript,
        replyText,
        finishStatus: runResult.output.finishStatus,
        artifactLink: runResult.output.artifactLink,
        stagedActionsCount,
        audioBase64: ttsResult?.audioBase64,
        audioMimeType: ttsResult?.mimeType
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || 'Failed to process voice turn' });
    }
  });

  // POST /api/voice/meeting - Background Meeting & Voice-Note Ingestion
  router.post('/meeting', async (req: Request, res: Response) => {
    const { audioBase64, mimeType, transcript, title, durationSeconds, instructions, postToSlack } = req.body || {};

    const hasTranscript = typeof transcript === 'string' && transcript.trim().length > 0;
    const hasAudio = typeof audioBase64 === 'string' && audioBase64.trim().length > 0;

    if (!hasTranscript && !hasAudio) {
      res.status(400).json({ ok: false, error: 'Either transcript or audioBase64 must be provided' });
      return;
    }

    let finalTranscript = '';
    if (hasAudio && !hasTranscript) {
      try {
        const transcribeRes = await modelRouter.transcribeAudio({
          audioBase64: audioBase64.trim(),
          mimeType: mimeType || 'audio/mp4',
          prompt: 'Transcribe this meeting or voice note accurately, preserving speaker turns and action items where clear.',
          source: 'voice_meeting'
        });
        finalTranscript = transcribeRes.text;
      } catch (err: any) {
        res.status(500).json({ ok: false, error: `Audio transcription failed: ${err.message || err}` });
        return;
      }
    } else if (hasTranscript) {
      finalTranscript = transcript.trim();
    }

    if (!finalTranscript) {
      res.status(400).json({ ok: false, error: 'Could not extract valid spoken or written transcript from input' });
      return;
    }

    const meetingTitle = (typeof title === 'string' && title.trim())
      ? title.trim()
      : `Meeting Note (${new Date().toISOString().replace('T', ' ').slice(0, 16)})`;

    const ownerInstructions = (typeof instructions === 'string' && instructions.trim())
      ? `\nOwner Instructions: ${instructions.trim()}\n`
      : '';

    const durationNote = (typeof durationSeconds === 'number' && durationSeconds > 0)
      ? `\nDuration: ${Math.round(durationSeconds / 60)} minutes (${durationSeconds}s)\n`
      : '';

    const meetingPrompt = `Meeting Recording / Voice Note Ingestion:
Title: ${meetingTitle}${durationNote}${ownerInstructions}
Transcript:
${finalTranscript}

Please process this meeting / voice note:
1. Provide a clear structured executive summary of what was discussed.
2. List key decisions made and key takeaways.
3. Extract concrete action items with assignees/next steps.
4. Execute or stage any requested follow-up actions (draft emails, create tasks/calendar events, or create docs) using your available tools.`;

    const allTools = dispatcher.getDeclaredTools().map(t => t.name);
    const resolved = resolveInteractiveSlackGrant({
      userText: meetingPrompt,
      allAvailableTools: allTools
    });
    for (const name of DOCUMENT_TOOL_NAMES) {
      if (allTools.includes(name)) resolved.add(name);
    }
    for (const name of MANAGEMENT_TOOL_NAMES) {
      if (allTools.includes(name)) resolved.add(name);
    }
    const grantedTools = Array.from(resolved);

    try {
      const runResult = await runner.run({
        trigger: 'manual',
        instruction: meetingPrompt,
        isInteractive: true,
        toolGrant: {
          allowedToolNames: resolved,
          allowConsequential: true
        }
      });

      const replyText = runResult.output.slackMessage || runResult.output.coworkerHeadline || runResult.output.summary || '';

      let slackRes: any;
      if (postToSlack !== false && slackClient?.isConfigured() && replyText.trim()) {
        try {
          const textToPost = `*Meeting Digest: ${meetingTitle}*\n\n${replyText}`;
          slackRes = await slackClient.postMessage({ text: textToPost });
        } catch (err: any) {
          console.warn(`[VoiceRouter] Failed to post meeting digest to Slack: ${err?.message || err}`);
        }
      }

      res.json({
        ok: true,
        runId: runResult.runId,
        title: meetingTitle,
        transcript: finalTranscript,
        summary: replyText,
        artifactLink: runResult.output.artifactLink,
        slackTs: slackRes?.ts
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || 'Failed to process meeting ingestion' });
    }
  });

  return router;
}
