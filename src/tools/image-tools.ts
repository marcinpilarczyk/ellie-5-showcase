import { z } from 'zod';
import { ToolDefinition, RunContext } from '../types/tool.js';
import type { ModelRouter } from '../models/model-router.js';
import type { SlackClient } from '../integrations/slack/client.js';

export const imageGenerateSchema = z.object({
  prompt: z.string().describe(
    'Detailed description of the image to generate, or precise instructions on how to edit, transform, or iterate on the reference image.'
  ),
  useReferenceImage: z.boolean().optional().describe(
    'Whether to use a reference image from the current message or thread history (defaults to true if images exist in the conversation). Set to false to force a fresh image generation from scratch.'
  ),
  referenceImageIndex: z.number().int().min(0).optional().describe(
    '0-based index of reference image to use when multiple images exist (0 = most recent image in the conversation). Defaults to 0.'
  ),
  aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe(
    'Output image aspect ratio. Options: 1:1 (square, default), 16:9 (widescreen landscape), 9:16 (vertical story/phone), 4:3 (standard photo), 3:4 (portrait).'
  ),
  title: z.string().optional().describe(
    'Short descriptive title or filename for the generated image.'
  )
});

export type ImageGenerateSpec = z.infer<typeof imageGenerateSchema>;

export interface ImageToolsDeps {
  modelRouter: ModelRouter;
  slackClient?: SlackClient;
  uploadToDrive?: (name: string, mimeType: string, data: Buffer) => Promise<{ id: string; webViewLink?: string }>;
  isAvailable?: () => boolean;
}

export function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    return buf;
  }
  const chunks: Buffer[] = [buf.subarray(0, 8)];
  let offset = 8;
  const CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'tRNS', 'IEND']);

  while (offset < buf.length) {
    if (offset + 8 > buf.length) break;
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const totalChunkLen = 12 + len;
    if (offset + totalChunkLen > buf.length) break;

    if (CRITICAL_CHUNKS.has(type)) {
      chunks.push(buf.subarray(offset, offset + totalChunkLen));
    }
    offset += totalChunkLen;
  }

  return Buffer.concat(chunks);
}

export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return buf;
  }
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  const STRIP_MARKERS = new Set([0xe1, 0xed, 0xfe]); // APP1 (EXIF/XMP), APP13 (IPTC), COM

  while (offset < buf.length) {
    if (buf[offset] !== 0xff) break;
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) break;
    const marker = buf[offset++];

    if (marker === 0xd9) { // EOI
      segments.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0xda) { // SOS (Start of Scan) - remainder is scan data until EOI
      segments.push(buf.subarray(offset - 2));
      break;
    }

    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    const totalSegLen = len + 2;
    if (offset - 2 + totalSegLen > buf.length) break;

    if (!STRIP_MARKERS.has(marker)) {
      segments.push(buf.subarray(offset - 2, offset - 2 + totalSegLen));
    }
    offset += len;
  }

  return Buffer.concat(segments);
}

export function stripImageMetadata(buf: Buffer): Buffer {
  if (!buf || buf.length < 4) return buf;
  // PNG check
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return stripPngMetadata(buf);
  }
  // JPEG check
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return stripJpegMetadata(buf);
  }
  return buf;
}

export function createImageTools(deps: ImageToolsDeps): ToolDefinition[] {
  const imageGenerate: ToolDefinition = {
    name: 'image_generate',
    description:
      'Generates or edits/iterates on images using Google Nano Banana (gemini-3.1-flash-image). ' +
      'Automatically uploads the generated image directly to the Slack conversation thread. ' +
      'Supports image-to-image iteration: when the owner uploads a reference image or asks to edit/iterate on a previously posted image, ' +
      'it seamlessly uses the reference image from the conversation and applies the requested modifications.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: imageGenerateSchema,
    isAvailable: deps.isAvailable,
    execute: async (params: ImageGenerateSpec, context: RunContext) => {
      // 1. Resolve reference images
      let referenceImages: Array<{ mimeType: string; data: string }> | undefined;
      const availableImages = context.recentImages || [];
      const shouldUseReference = params.useReferenceImage !== false && availableImages.length > 0;

      if (shouldUseReference) {
        const idx = params.referenceImageIndex ?? 0;
        const targetImg = idx < availableImages.length ? availableImages[idx] : availableImages[0];
        if (targetImg) {
          referenceImages = [{ mimeType: targetImg.mimeType, data: targetImg.data }];
        }
      }

      // 2. Generate image using Nano Banana via ModelRouter
      const generated = await deps.modelRouter.generateImage({
        prompt: params.prompt,
        referenceImages,
        aspectRatio: params.aspectRatio
      });

      // Strip all EXIF, ancillary text chunks, timestamps, and metadata
      const cleanBuffer = stripImageMetadata(generated.buffer);

      // 3. Deliver to Slack thread
      const channel = context.slackOrigin?.channel;
      const threadTs = context.slackOrigin?.threadTs;
      const cleanTitle = (params.title || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
      const filename = `${cleanTitle}_${Date.now()}.png`;

      let slackResult: any;
      if (deps.slackClient && typeof deps.slackClient.uploadFile === 'function') {
        slackResult = await deps.slackClient.uploadFile({
          buffer: cleanBuffer,
          filename,
          title: params.title || 'Generated Image',
          channel,
          thread_ts: threadTs,
          initial_comment: generated.description || `🎨 ${params.prompt}`
        });

        if (!slackResult.ok) {
          console.warn('[image_generate] Slack file upload returned error:', slackResult.error);
        }
      }

      // 4. Optionally archive to Google Drive if configured
      let driveResult: { id?: string; webViewLink?: string } | undefined;
      if (deps.uploadToDrive) {
        try {
          driveResult = await deps.uploadToDrive(filename, generated.mimeType || 'image/png', cleanBuffer);
        } catch (err: any) {
          console.warn('[image_generate] Optional Drive upload skipped:', err.message);
        }
      }

      // 5. Update local recentImages context for any immediate follow-up in this run
      if (context.recentImages) {
        context.recentImages.unshift({
          mimeType: generated.mimeType || 'image/png',
          data: cleanBuffer.toString('base64'),
          name: filename
        });
      }

      return {
        ok: true,
        deliveredTo: 'slack',
        slackFileId: slackResult?.file_id,
        slackPermalink: slackResult?.permalink,
        usedReferenceImage: Boolean(referenceImages && referenceImages.length > 0),
        referenceImageUsed: referenceImages ? true : false,
        aspectRatio: params.aspectRatio || '1:1',
        description: generated.description || 'Image generated and posted to thread.',
        ...(driveResult?.webViewLink ? { driveLink: driveResult.webViewLink } : {})
      };
    }
  };

  return [imageGenerate];
}
