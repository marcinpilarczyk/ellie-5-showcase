import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ModelRouter } from '../models/model-router.js';
import { OwnerSources } from './owner-source-tools.js';
import { OWNER_NAME, OWNER_FULL_NAME, ownerIntro } from '../config/owner.js';
import { fetchWebPage } from './web-tools.js';

export const JOB_EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['APPLY', 'APPLY_WITH_CAVEATS', 'SKIP'],
      description: 'APPLY: role squarely leverages strengths and fits criteria. APPLY_WITH_CAVEATS: solid opportunity with a known issue (domain pivot, pay, hybrid constraints). SKIP: clear deal-breaker or major mismatch.'
    },
    priority: {
      type: 'string',
      enum: ['HIGH', 'MEDIUM', 'LOW'],
      description: 'HIGH: immediate pursuit recommended; MEDIUM: standard pipeline; LOW: backlog / opportunistic.'
    },
    overallFitScore: {
      type: 'number',
      description: 'Calibrated fit score from 0.0 to 10.0 (one decimal place).'
    },
    bottomLine: {
      type: 'string',
      description: '1-2 blunt, direct sentences: the decision and the primary justification without buzzwords.'
    },
    scores: {
      type: 'object',
      properties: {
        leadershipAndScope: { type: 'number', description: '0 to 10 rating of leadership, ownership, and scope alignment' },
        technicalGenAiFit: { type: 'number', description: '0 to 10 rating of GenAI, AI agents, technical transformation alignment' },
        compensationAndTerms: { type: 'number', description: '0 to 10 rating of compensation, location, work model alignment' },
        dealBreakerRisk: { type: 'number', description: '0 (zero risk) to 10 (fatal deal-breaker present)' }
      },
      required: ['leadershipAndScope', 'technicalGenAiFit', 'compensationAndTerms', 'dealBreakerRisk']
    },
    keyMatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: 'Exact or closely paraphrased posting requirement' },
          dossierEvidence: { type: 'string', description: `Concrete proof point from ${OWNER_NAME}'s verified dossier or claims bank` }
        },
        required: ['requirement', 'dossierEvidence']
      },
      description: 'Top 3-5 verified evidence points proving qualifications.'
    },
    frictionPoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string', description: 'Real gap, potential risk, or unstated ambiguity' },
          severity: { type: 'string', enum: ['DEAL_BREAKER', 'CAVEAT', 'MINOR_GAP'] },
          handlingStrategy: { type: 'string', description: 'How to position around or resolve this friction point' }
        },
        required: ['point', 'severity', 'handlingStrategy']
      },
      description: 'Honest gaps or risks and how to handle them.'
    },
    positioningHook: {
      type: 'string',
      description: 'The core narrative angle or strategic thesis to emphasize in tailored resumes and outreach.'
    }
  },
  required: ['verdict', 'priority', 'overallFitScore', 'bottomLine', 'scores', 'keyMatches', 'frictionPoints', 'positioningHook']
};

export function createJobEvaluationTools(
  modelRouter: ModelRouter,
  ownerSources?: OwnerSources
): ToolDefinition[] {
  const jobEvaluate: ToolDefinition = {
    name: 'job_evaluate',
    description: `Evaluates a job ad or posting URL against ${OWNER_FULL_NAME}'s verified dossier, target roles, pay expectations, deal-breakers, and Claims Bank using a structured decision engine backed by the reasoning model. Returns verdict (APPLY/APPLY_WITH_CAVEATS/SKIP), calibrated fit score, dimensional scores, verified evidence matches, friction points, and positioning hook.`,
    effectClass: 'READ',
    schema: z.object({
      url: z.string().url().optional().describe('Job posting URL to fetch and evaluate (LinkedIn, company careers page, etc.)'),
      job_text: z.string().optional().describe('Direct text of the job description if already available or not accessible via URL')
    }),
    execute: async (params, ctx?: any) => {
      let jobText = (params.job_text || '').trim();
      let jobTitle = 'Job Posting';

      if (params.url && !jobText) {
        ctx?.onProgress?.(`Fetching job posting from ${params.url}...`);
        const fetchRes = await fetchWebPage(params.url);
        if (fetchRes.status !== 'SUCCESS') {
          return {
            status: 'FETCH_FAILED',
            reason: `Could not retrieve job posting from ${params.url}: ${fetchRes.content}`
          };
        }
        jobText = fetchRes.content;
        jobTitle = fetchRes.title || 'Job Posting';
      }

      if (!jobText) {
        throw new Error('Either url or job_text must be provided to evaluate a job.');
      }

      ctx?.onProgress?.(`Loading ${OWNER_NAME}'s verified sources and dossier...`);

      // 1. Gather relevant working Docs from ownerSources (career, dossier, claims, profile)
      let sourceDocsText = '';
      if (ownerSources) {
        try {
          const snapshot = await ownerSources.documents();
          const CAREER_KEYWORDS = /job|career|resume|cv|profile|dossier|claim|record|config|target|preference/i;
          const relevant = snapshot.docs.filter(d =>
            !d.path || d.path === '/' || d.path === '(linked)' || CAREER_KEYWORDS.test(`${d.title} ${d.path}`)
          );
          const docsToUse = relevant.length > 0 ? relevant : snapshot.docs;
          sourceDocsText = docsToUse.map(d => `--- ${d.title} (${d.path || 'root'}) ---\n${d.text}`).join('\n\n').trim();
        } catch (err: any) {
          console.warn('[job_evaluate] Could not read ownerSources snapshot:', err.message);
        }
      }

      const ownerContext = [
        ownerIntro(),
        sourceDocsText ? `\n--- VERIFIED OWNER SOURCES & DOSSIER ---\n${sourceDocsText.slice(0, 28000)}` : ''
      ].filter(Boolean).join('\n\n');

      ctx?.onProgress?.('Running JEV decision engine on reasoning model (gemini-4-argon)...');

      const evaluationPrompt = `You are the JEV Decision Engine for Ellie (AI Chief of Staff to ${OWNER_FULL_NAME}).
Your job is to objectively, rigorously evaluate whether ${OWNER_NAME} should apply for this specific role.

EVALUATION DIRECTIVES:
1. Ground truth: Judge strictly against ${OWNER_NAME}'s verified professional record, targets, and deal-breakers below.
2. No rose-colored glasses: Do not act like an encouraging recruiter or keyword-matching cheerleader. Look for the ACTUAL day-to-day problems this person will own, reporting lines, and organizational reality.
3. Deal-breakers: If compensation, required full-time on-site location, or excluded industry violates ${OWNER_NAME}'s explicit criteria, mark as DEAL_BREAKER and SKIP.
4. Experience floor vs ceiling: Years of experience in job specs are floors, not ceilings. ${OWNER_NAME} being senior or having 20+ years of tech/leadership experience is an asset unless the role is clearly an entry-level IC role.
5. Calibrated scoring:
   - 8.0 - 10.0: APPLY. Clear strategic fit, uses strengths, compensation & terms match.
   - 6.5 - 7.9: APPLY_WITH_CAVEATS. Solid opportunity but requires careful positioning, pay negotiation, or domain bridge.
   - Below 6.5: SKIP. Mismatch in scope, deal-breaker, or poor leverage of strengths.

${ownerContext}

--- JOB DESCRIPTION TO EVALUATE (${jobTitle}) ---
${jobText.slice(0, 20000)}

Analyze and return the structured decision.`;

      const response = await modelRouter.generate(evaluationPrompt, {
        tier: 'ANALYSIS', // Routes to gemini-4-argon
        temperature: 0.1,
        responseSchema: JOB_EVALUATION_SCHEMA,
        responseMimeType: 'application/json',
        source: 'job_evaluate',
        sourceId: ctx?.runId
      });

      let decision: any;
      try {
        decision = JSON.parse(response.text);
      } catch (err: any) {
        throw new Error(`Failed to parse JEV decision engine output: ${err.message}. Raw text: ${response.text.slice(0, 300)}`);
      }

      // Format clean coworker summary for Slack
      const verdictEmoji = decision.verdict === 'APPLY' ? '✅' : decision.verdict === 'APPLY_WITH_CAVEATS' ? '⚠️' : '🛑';
      const keyMatchesFormatted = (decision.keyMatches || []).map((m: any) => `• *${m.requirement}* → ${m.dossierEvidence}`).join('\n');
      const frictionFormatted = (decision.frictionPoints || []).map((f: any) => `• [${f.severity}] *${f.point}*: ${f.handlingStrategy}`).join('\n');

      const coworkerSummary = `${verdictEmoji} *Job Fit Evaluation: ${decision.verdict.replace(/_/g, ' ')}* (Score: *${decision.overallFitScore}/10*, Priority: *${decision.priority}*)
${decision.bottomLine}

*Key Proof Points:*
${keyMatchesFormatted || '• No specific direct matches isolated'}

*Friction & Caveats:*
${frictionFormatted || '• None identified'}

*Positioning Hook:*
${decision.positioningHook}`;

      return {
        decision,
        coworkerSummary,
        modelUsed: response.telemetry.model,
        durationMs: response.telemetry.durationMs
      };
    }
  };

  return [jobEvaluate];
}
