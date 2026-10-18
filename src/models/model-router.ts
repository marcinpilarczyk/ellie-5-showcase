import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { CostRepository } from '../storage/cost-repo.js';
import { TokenTelemetry } from '../types/runner.js';

export type ModelTier = 'SENTINEL' | 'ROUTINE' | 'INTERACTIVE' | 'ESCALATION' | 'ANALYSIS' | 'EVALUATOR';

export interface ModelCallConfig {
  tier: ModelTier;
  temperature?: number;
  thinkingLevel?: 'low' | 'medium' | 'high';
  systemInstruction?: string;
  tools?: any[];
  /** Gemini function-calling config, e.g. { functionCallingConfig: { mode: 'ANY', allowedFunctionNames } } */
  toolConfig?: Record<string, any>;
  /**
   * Serve systemInstruction + tools + toolConfig from an explicit Gemini context cache.
   * Implicit caching hit ~0-4% in production; the ~7k-token prefix is the bulk of every call.
   */
  cachePrefix?: boolean;
  responseSchema?: Record<string, any>;
  responseMimeType?: string;
  /** Granular media resolution for multimodal vision processing (e.g. 'MEDIA_RESOLUTION_LOW' or 'MEDIA_RESOLUTION_MEDIUM'). */
  mediaResolution?: string;
  source?: string;
  sourceId?: string;
}

export interface ModelCallResponse {
  text: string;
  functionCalls?: Array<{ id?: string; name: string; args: any }>;
  telemetry: TokenTelemetry;
  rawResponse?: any;
}

export interface GenerateImageOptions {
  prompt: string;
  referenceImages?: Array<{ mimeType: string; data: string }>;
  aspectRatio?: string;
}

export interface GenerateImageResult {
  buffer: Buffer;
  mimeType: string;
  description?: string;
}

function interactiveThinking(): 'low' | 'medium' | 'high' {
  const v = (process.env.GEMINI_INTERACTIVE_THINKING || '').toLowerCase();
  return v === 'low' || v === 'high' ? v : 'medium';
}

const REASONING_MENTION = /\b(argon\w*|reasoning model|reasoning mode|pro model|deep reasoning|think hard|flash only|only flash|use flash)\b/;

/** True when the text names the reasoning model, whether to ask for it or to refuse it. */
export function mentionsReasoningModel(text?: string): boolean {
  return Boolean(text) && REASONING_MENTION.test(text!.toLowerCase());
}

/**
 * True when the owner asks for the reasoning model by name ("use argon", "with the reasoning model", "użyj argona").
 * An explicit refusal ("don't use argon", "flash only") wins. Deterministic on purpose: the tier is chosen in code.
 */
export function explicitReasoningRequest(text?: string): boolean {
  if (!text || !mentionsReasoningModel(text)) return false;
  const t = text.toLowerCase();
  const refused = /\b(no|not|don'?t|do not|without|never|nie|bez)\b[^.!?\n]{0,25}\b(argon\w*|reasoning|pro model)\b|\bflash only\b|\bonly flash\b/.test(t);
  return !refused;
}

/**
 * Sticky within a thread: the newest owner message that mentions the reasoning model decides, so a bare
 * "continue" after "make the resume with argon" stays on it, and "flash only" switches it off again.
 */
export function reasoningRequestedInThread(current: string | undefined, earlierOwnerTexts: string[] = []): boolean {
  for (const text of [current, ...[...earlierOwnerTexts].reverse()]) {
    if (mentionsReasoningModel(text)) return explicitReasoningRequest(text);
  }
  return false;
}

const PREFIX_CACHE_TTL_S = 1800;
const PREFIX_CACHE_RETRY_AFTER_MS = 60 * 60_000;

interface PrefixCacheEntry {
  name?: string;
  expiresAt: number;
  failedUntil?: number;
  pending?: Promise<string | undefined>;
}

export class ModelRouter {
  private readonly client: GoogleGenAI;
  private readonly prefixCaches = new Map<string, PrefixCacheEntry>();
  public readonly modelName: string;
  public readonly flashModel: string;
  /** Reasoning model for ANALYSIS/EVALUATOR tiers; equals flashModel when none is configured. */
  public readonly reasoningModel: string;
  /** Image generation model (Nano Banana: gemini-3.1-flash-image). */
  public readonly imageModel: string;
  public readonly transcribeModel: string;
  public readonly ttsModel: string;
  public readonly liveModel: string;

  constructor(private readonly costRepo?: CostRepository) {
    const apiKey = process.env.GEMINI_API_KEY || '';
    this.client = new GoogleGenAI({ apiKey });
    // No invented defaults for model ids: `npm run doctor` checks both against the API.
    this.flashModel = process.env.GEMINI_FLASH_MODEL?.trim() || 'gemini-3.8-flash';
    this.reasoningModel = (process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_PRO_MODEL || '').trim() || this.flashModel;
    this.imageModel = (process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image').trim();
    this.transcribeModel = (process.env.GEMINI_TRANSCRIBE_MODEL || '').trim() || 'gemini-3.5-transcribe';
    this.ttsModel = (process.env.GEMINI_TTS_MODEL || '').trim() || 'gemini-3.8-flash-lite-tts';
    this.liveModel = (process.env.GEMINI_LIVE_MODEL || '').trim() || 'gemini-3.8-live';
    this.modelName = this.flashModel;
  }

  public getTierConfig(tier: ModelTier): { model: string; thinkingLevel: 'low' | 'medium' | 'high'; temperature: number } {
    switch (tier) {
      case 'SENTINEL':
        return { model: this.flashModel, thinkingLevel: 'low', temperature: 0.0 };
      case 'ROUTINE':
        return { model: this.flashModel, thinkingLevel: 'medium', temperature: 0.2 };
      case 'ANALYSIS':
      case 'EVALUATOR':
        // Deep analysis and evaluation routed to the reasoning model
        return { model: this.reasoningModel, thinkingLevel: 'high', temperature: 0.2 };
      case 'INTERACTIVE':
        // Medium keeps Slack replies fast; tool failures escalate to high (ESCALATION tier)
        return { model: this.flashModel, thinkingLevel: interactiveThinking(), temperature: 0.3 };
      case 'ESCALATION':
      default:
        return { model: this.flashModel, thinkingLevel: 'high', temperature: 0.3 };
    }
  }

  /** Returns a live cache name for this exact prefix, creating it if needed; undefined means "send uncached". */
  private async prefixCacheName(model: string, requestConfig: any, source?: string): Promise<string | undefined> {
    if (process.env.GEMINI_PREFIX_CACHE === 'off') return undefined;
    const key = createHash('sha256')
      .update(JSON.stringify([model, requestConfig.systemInstruction, requestConfig.tools, requestConfig.toolConfig]))
      .digest('hex');
    const now = Date.now();
    const entry = this.prefixCaches.get(key);
    if (entry?.failedUntil && entry.failedUntil > now) return undefined;
    if (entry?.name && entry.expiresAt - 60_000 > now) return entry.name;
    if (entry?.pending) return entry.pending;

    const pending = (async () => {
      try {
        const cache: any = await this.client.caches.create({
          model,
          config: {
            systemInstruction: requestConfig.systemInstruction,
            tools: requestConfig.tools,
            toolConfig: requestConfig.toolConfig,
            ttl: `${PREFIX_CACHE_TTL_S}s`,
            displayName: 'ellie-prefix'
          }
        });
        this.prefixCaches.set(key, { name: cache.name, expiresAt: Date.now() + PREFIX_CACHE_TTL_S * 1000 });
        // Creating a cache bills its tokens once as input
        const created = cache.usageMetadata?.totalTokenCount || 0;
        if (created && this.costRepo) {
          try {
            this.costRepo.recordUsage({
              model, source: 'prefix_cache', source_id: source,
              prompt_tokens: created, cached_tokens: 0, thinking_tokens: 0, completion_tokens: 0, total_tokens: created
            });
          } catch {}
        }
        return cache.name as string;
      } catch (err: any) {
        console.warn(`[ModelRouter] Prefix cache unavailable for ${model}: ${err.message}. Sending uncached for the next hour.`);
        this.prefixCaches.set(key, { expiresAt: 0, failedUntil: Date.now() + PREFIX_CACHE_RETRY_AFTER_MS });
        return undefined;
      }
    })();
    this.prefixCaches.set(key, { expiresAt: 0, pending });
  }

  /** Proactively creates the prefix cache in the background to hide round-1 latency. */
  public warmPrefixCache(config: ModelCallConfig): void {
    if (process.env.GEMINI_PREFIX_CACHE === 'off' || !config.tools || config.tools.length === 0) return;
    const tierDefaults = this.getTierConfig(config.tier);
    const requestConfig = {
      systemInstruction: config.systemInstruction,
      tools: config.tools,
      toolConfig: config.toolConfig
    };
    this.prefixCacheName(tierDefaults.model, requestConfig, config.sourceId).catch(() => {});
  }

  public async generate(contents: any, config: ModelCallConfig): Promise<ModelCallResponse> {
    const tierDefaults = this.getTierConfig(config.tier);
    const thinkingLevel = config.thinkingLevel || tierDefaults.thinkingLevel;
    const temperature = config.temperature !== undefined ? config.temperature : tierDefaults.temperature;
    let targetModel = tierDefaults.model;

    const requestConfig: any = {
      temperature,
      thinkingConfig: {
        thinkingLevel
      }
    };

    if (config.systemInstruction) {
      requestConfig.systemInstruction = config.systemInstruction;
    }

    if (config.tools && config.tools.length > 0) {
      requestConfig.tools = config.tools;
      if (config.toolConfig) {
        requestConfig.toolConfig = config.toolConfig;
      }
    }

    if (config.responseSchema) {
      requestConfig.responseMimeType = config.responseMimeType || 'application/json';
      requestConfig.responseSchema = config.responseSchema;
    } else if (config.responseMimeType) {
      requestConfig.responseMimeType = config.responseMimeType;
    }

    if (config.mediaResolution) {
      requestConfig.mediaResolution = config.mediaResolution;
    }

    const start = Date.now();
    let response: any;
    let modelUsed = targetModel;

    // Explicit prefix cache: the request then carries only the conversation
    let primaryConfig = requestConfig;
    if (config.cachePrefix && requestConfig.tools) {
      const cacheName = await this.prefixCacheName(targetModel, requestConfig, config.sourceId);
      if (cacheName) {
        const { systemInstruction: _s, tools: _t, toolConfig: _tc, ...rest } = requestConfig;
        primaryConfig = { ...rest, cachedContent: cacheName };
      }
    }

    try {
      try {
        response = await this.client.models.generateContent({
          model: targetModel,
          contents,
          config: primaryConfig
        });
      } catch (cacheErr: any) {
        if (primaryConfig === requestConfig) throw cacheErr;
        // Cache expired or rejected: forget it and send this request uncached
        for (const [k, v] of this.prefixCaches) {
          if (v.name === primaryConfig.cachedContent) this.prefixCaches.delete(k);
        }
        response = await this.client.models.generateContent({
          model: targetModel,
          contents,
          config: requestConfig
        });
      }
    } catch (primaryErr: any) {
      // If the reasoning model failed or was unavailable, fall back to Flash with high thinking
      if (targetModel === this.reasoningModel && targetModel !== this.flashModel) {
        console.warn(`[ModelRouter] Primary model ${this.reasoningModel} failed: ${primaryErr.message}. Falling back to ${this.flashModel} (high thinking).`);
        try {
          modelUsed = this.flashModel;
          response = await this.client.models.generateContent({
            model: this.flashModel,
            contents,
            config: {
              ...requestConfig,
              thinkingConfig: { thinkingLevel: 'high' }
            }
          });
        } catch (fallbackErr: any) {
          const durationMs = Date.now() - start;
          const emptyTelemetry: TokenTelemetry = {
            promptTokens: 0,
            cachedTokens: 0,
            thinkingTokens: 0,
            candidatesTokens: 0,
            totalTokens: 0,
            model: this.flashModel,
            durationMs
          };
          throw Object.assign(fallbackErr, { telemetry: emptyTelemetry });
        }
      } else {
        const durationMs = Date.now() - start;
        const emptyTelemetry: TokenTelemetry = {
          promptTokens: 0,
          cachedTokens: 0,
          thinkingTokens: 0,
          candidatesTokens: 0,
          totalTokens: 0,
          model: targetModel,
          durationMs
        };
        throw Object.assign(primaryErr, { telemetry: emptyTelemetry });
      }
    }

    const durationMs = Date.now() - start;

    const promptTokens = response?.usageMetadata?.promptTokenCount || 0;
    const cachedTokens = response?.usageMetadata?.cachedContentTokenCount || 0;
    const thinkingTokens = response?.usageMetadata?.thoughtsTokenCount || 0;
    const candidatesTokens = response?.usageMetadata?.candidatesTokenCount || 0;
    const totalTokens = response?.usageMetadata?.totalTokenCount || (promptTokens + candidatesTokens);

    const telemetry: TokenTelemetry = {
      promptTokens,
      cachedTokens,
      thinkingTokens,
      candidatesTokens,
      totalTokens,
      model: modelUsed,
      durationMs
    };

    if (this.costRepo) {
      try {
        this.costRepo.recordUsage({
          model: modelUsed,
          source: config.source || config.tier,
          source_id: config.sourceId,
          prompt_tokens: promptTokens,
          cached_tokens: cachedTokens,
          thinking_tokens: thinkingTokens,
          completion_tokens: candidatesTokens,
          total_tokens: totalTokens
        });
      } catch {}
    }

    // CHECK FUNCTION CALLS FIRST
    // In @google/genai, accessing response.text when candidate parts contain non-text functionCall
    // triggers the SDK warning "there are non-text parts functionCall in the response".
    let functionCalls: Array<{ id?: string; name: string; args: any }> | undefined;
    if (response?.functionCalls) {
      if (typeof response.functionCalls === 'function') {
        try { functionCalls = response.functionCalls(); } catch {}
      } else if (Array.isArray(response.functionCalls)) {
        functionCalls = response.functionCalls;
      }
    }

    // Check candidate content parts if response.functionCalls wasn't populated directly
    if (!functionCalls || functionCalls.length === 0) {
      const candidateParts = response?.candidates?.[0]?.content?.parts;
      if (Array.isArray(candidateParts)) {
        const extracted = candidateParts
          .filter((p: any) => Boolean(p.functionCall))
          .map((p: any) => ({
            name: p.functionCall.name,
            args: p.functionCall.args || {}
          }));
        if (extracted.length > 0) {
          functionCalls = extracted;
        }
      }
    }

    // ONLY read response.text if there are NO function calls
    let text = '';
    if (!functionCalls || functionCalls.length === 0) {
      try {
        text = response?.text?.trim() || '';
      } catch {
        // Fallback: extract text parts manually if getter throws
        const parts = response?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          text = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('').trim();
        }
      }
    }

    return {
      text,
      functionCalls,
      telemetry,
      rawResponse: response
    };
  }

  public async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    const contents: any[] = [];
    if (Array.isArray(options.referenceImages) && options.referenceImages.length > 0) {
      for (const img of options.referenceImages) {
        if (img?.data) {
          contents.push({
            inlineData: {
              mimeType: img.mimeType || 'image/png',
              data: img.data
            }
          });
        }
      }
    }
    contents.push({ text: options.prompt });

    const requestConfig: Record<string, any> = {
      responseModalities: ['TEXT', 'IMAGE']
    };
    if (options.aspectRatio) {
      requestConfig.imageConfig = { aspectRatio: options.aspectRatio };
    }

    const response = await this.client.models.generateContent({
      model: this.imageModel,
      contents,
      config: requestConfig
    });

    const candidateParts = response?.candidates?.[0]?.content?.parts || [];
    let imageBuffer: Buffer | undefined;
    let mimeType = 'image/png';
    let description: string | undefined;

    for (const part of candidateParts) {
      if (part.inlineData?.data) {
        imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        if (part.inlineData.mimeType) {
          mimeType = part.inlineData.mimeType;
        }
      } else if (typeof part.text === 'string' && part.text.trim()) {
        description = part.text.trim();
      }
    }

    if (!imageBuffer) {
      throw new Error(`Model ${this.imageModel} did not return image data.`);
    }

    return {
      buffer: imageBuffer,
      mimeType,
      description
    };
  }

  public async transcribeAudio(options: {
    audioBase64: string;
    mimeType: string;
    prompt?: string;
    source?: string;
  }): Promise<{ text: string; telemetry: TokenTelemetry }> {
    const start = Date.now();
    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: options.mimeType || 'audio/mp4',
              data: options.audioBase64
            }
          },
          {
            text: options.prompt || 'Transcribe this audio accurately. Return only the spoken words without commentary.'
          }
        ]
      }
    ];

    let response: any;
    let modelUsed = this.transcribeModel;

    try {
      response = await this.client.models.generateContent({
        model: this.transcribeModel,
        contents
      });
    } catch (primaryErr: any) {
      if (this.transcribeModel !== this.flashModel) {
        console.warn(`[ModelRouter] transcribeModel (${this.transcribeModel}) failed: ${primaryErr?.message || primaryErr}. Falling back to flashModel (${this.flashModel}).`);
        modelUsed = this.flashModel;
        response = await this.client.models.generateContent({
          model: this.flashModel,
          contents
        });
      } else {
        throw primaryErr;
      }
    }

    const durationMs = Date.now() - start;
    const promptTokens = response?.usageMetadata?.promptTokenCount || 0;
    const cachedTokens = response?.usageMetadata?.cachedContentTokenCount || 0;
    const thinkingTokens = response?.usageMetadata?.thoughtsTokenCount || 0;
    const candidatesTokens = response?.usageMetadata?.candidatesTokenCount || 0;
    const totalTokens = response?.usageMetadata?.totalTokenCount || (promptTokens + candidatesTokens);

    const telemetry: TokenTelemetry = {
      promptTokens,
      cachedTokens,
      thinkingTokens,
      candidatesTokens,
      totalTokens,
      model: modelUsed,
      durationMs
    };

    if (this.costRepo) {
      try {
        this.costRepo.recordUsage({
          model: modelUsed,
          source: options.source || 'voice_transcribe',
          prompt_tokens: promptTokens,
          cached_tokens: cachedTokens,
          thinking_tokens: thinkingTokens,
          completion_tokens: candidatesTokens,
          total_tokens: totalTokens
        });
      } catch {}
    }

    let text = '';
    try {
      text = response?.text?.trim() || '';
    } catch {
      const parts = response?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        text = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('').trim();
      }
    }

    return { text, telemetry };
  }

  public async synthesizeSpeech(options: {
    text: string;
    voiceName?: string;
    source?: string;
  }): Promise<{ audioBase64: string; mimeType: string } | undefined> {
    if (!options.text || !options.text.trim()) {
      return undefined;
    }

    try {
      const config: Record<string, any> = {
        responseModalities: ['AUDIO'],
        ...(options.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } } } : {})
      };

      const response = await this.client.models.generateContent({
        model: this.ttsModel,
        contents: [{ role: 'user', parts: [{ text: options.text }] }],
        config
      });

      const parts = response?.candidates?.[0]?.content?.parts;
      const audioPart = Array.isArray(parts) ? parts.find((p: any) => Boolean(p?.inlineData?.data)) : undefined;

      if (!audioPart?.inlineData?.data) {
        return undefined;
      }

      if (this.costRepo) {
        const promptTokens = response?.usageMetadata?.promptTokenCount || 0;
        const candidatesTokens = response?.usageMetadata?.candidatesTokenCount || 0;
        const totalTokens = response?.usageMetadata?.totalTokenCount || (promptTokens + candidatesTokens);
        try {
          this.costRepo.recordUsage({
            model: this.ttsModel,
            source: options.source || 'voice_tts',
            prompt_tokens: promptTokens,
            cached_tokens: response?.usageMetadata?.cachedContentTokenCount || 0,
            thinking_tokens: response?.usageMetadata?.thoughtsTokenCount || 0,
            completion_tokens: candidatesTokens,
            total_tokens: totalTokens
          });
        } catch {}
      }

      return {
        audioBase64: audioPart.inlineData.data,
        mimeType: audioPart.inlineData.mimeType || 'audio/wav'
      };
    } catch (err: any) {
      console.warn(`[ModelRouter] synthesizeSpeech failed: ${err?.message || err}`);
      return undefined;
    }
  }
}


