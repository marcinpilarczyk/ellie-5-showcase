import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createImageTools } from '../tools/image-tools.js';
import { RunContext } from '../types/tool.js';

describe('Image Tools (Nano Banana)', () => {
  it('creates image_generate tool with correct schema and effectClass', () => {
    const mockRouter: any = {
      imageModel: 'gemini-3.1-flash-image',
      generateImage: async () => ({
        buffer: Buffer.from('mock-png-bytes'),
        mimeType: 'image/png'
      })
    };

    const tools = createImageTools({ modelRouter: mockRouter });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'image_generate');
    assert.equal(tools[0].effectClass, 'INTERNAL_REVERSIBLE_WRITE');
  });

  it('generates a fresh text-to-image and uploads to Slack thread', async () => {
    let capturedOptions: any;
    const mockRouter: any = {
      imageModel: 'gemini-3.1-flash-image',
      generateImage: async (opts: any) => {
        capturedOptions = opts;
        return {
          buffer: Buffer.from('generated-image-data'),
          mimeType: 'image/png',
          description: 'A futuristic cityscape with neon lights'
        };
      }
    };

    let uploadedPayload: any;
    const mockSlackClient: any = {
      uploadFile: async (opts: any) => {
        uploadedPayload = opts;
        return {
          ok: true,
          file_id: 'F12345678',
          permalink: 'https://slack.com/files/F12345678'
        };
      }
    };

    const tools = createImageTools({
      modelRouter: mockRouter,
      slackClient: mockSlackClient
    });

    const context: RunContext = {
      runId: 'run-1',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['image_generate']), allowConsequential: true },
      slackOrigin: { channel: 'C_MAIN', threadTs: '1700000000.000100' },
      recentImages: []
    };

    const result = await tools[0].execute(
      {
        prompt: 'Futuristic cityscape in neon cyberpunk style',
        aspectRatio: '16:9',
        title: 'Cyberpunk City'
      },
      context
    );

    // Verify model was called with prompt and aspect ratio
    assert.equal(capturedOptions.prompt, 'Futuristic cityscape in neon cyberpunk style');
    assert.equal(capturedOptions.aspectRatio, '16:9');
    assert.equal(capturedOptions.referenceImages, undefined);

    // Verify Slack file upload received the buffer and thread info
    assert.ok(uploadedPayload);
    assert.equal(uploadedPayload.channel, 'C_MAIN');
    assert.equal(uploadedPayload.thread_ts, '1700000000.000100');
    assert.equal(uploadedPayload.title, 'Cyberpunk City');
    assert.equal(uploadedPayload.buffer.toString(), 'generated-image-data');

    // Verify result structure
    assert.equal(result.ok, true);
    assert.equal(result.deliveredTo, 'slack');
    assert.equal(result.slackFileId, 'F12345678');
    assert.equal(result.slackPermalink, 'https://slack.com/files/F12345678');
    assert.equal(result.usedReferenceImage, false);

    // Verify newly generated image was prepended to recentImages for iterative turns
    assert.equal(context.recentImages?.length, 1);
    assert.equal(context.recentImages?.[0].mimeType, 'image/png');
    assert.equal(
      Buffer.from(context.recentImages?.[0].data!, 'base64').toString(),
      'generated-image-data'
    );
  });

  it('performs image-to-image iteration using reference image from context.recentImages', async () => {
    let capturedOptions: any;
    const mockRouter: any = {
      imageModel: 'gemini-3.1-flash-image',
      generateImage: async (opts: any) => {
        capturedOptions = opts;
        return {
          buffer: Buffer.from('transformed-image-data'),
          mimeType: 'image/png',
          description: 'Same character now wearing cyberpunk sunglasses'
        };
      }
    };

    const mockSlackClient: any = {
      uploadFile: async () => ({
        ok: true,
        file_id: 'F99999999',
        permalink: 'https://slack.com/files/F99999999'
      })
    };

    const tools = createImageTools({
      modelRouter: mockRouter,
      slackClient: mockSlackClient
    });

    const context: RunContext = {
      runId: 'run-2',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['image_generate']), allowConsequential: true },
      slackOrigin: { channel: 'C_MAIN', threadTs: '1700000000.000200' },
      recentImages: [
        { mimeType: 'image/jpeg', data: Buffer.from('original-character-image').toString('base64'), name: 'orig.jpg' },
        { mimeType: 'image/png', data: Buffer.from('older-reference').toString('base64'), name: 'old.png' }
      ]
    };

    const result = await tools[0].execute(
      {
        prompt: 'Add cool futuristic cyberpunk sunglasses to the character',
        useReferenceImage: true,
        aspectRatio: '1:1'
      },
      context
    );

    // Verify the latest reference image (index 0) was passed to the model
    assert.ok(capturedOptions.referenceImages);
    assert.equal(capturedOptions.referenceImages.length, 1);
    assert.equal(capturedOptions.referenceImages[0].mimeType, 'image/jpeg');
    assert.equal(
      Buffer.from(capturedOptions.referenceImages[0].data, 'base64').toString(),
      'original-character-image'
    );
    assert.equal(capturedOptions.prompt, 'Add cool futuristic cyberpunk sunglasses to the character');

    // Verify result reflects reference image usage
    assert.equal(result.usedReferenceImage, true);
    assert.equal(result.referenceImageUsed, true);

    // Verify the updated image became the latest recentImage
    assert.equal(context.recentImages?.length, 3);
    assert.equal(
      Buffer.from(context.recentImages?.[0].data!, 'base64').toString(),
      'transformed-image-data'
    );
  });

  it('allows selecting specific reference image index or forcing fresh generation', async () => {
    let capturedOptions: any;
    const mockRouter: any = {
      imageModel: 'gemini-3.1-flash-image',
      generateImage: async (opts: any) => {
        capturedOptions = opts;
        return {
          buffer: Buffer.from('fresh-image'),
          mimeType: 'image/png'
        };
      }
    };

    const tools = createImageTools({
      modelRouter: mockRouter,
      slackClient: { uploadFile: async () => ({ ok: true }) } as any
    });

    const context: RunContext = {
      runId: 'run-3',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['image_generate']), allowConsequential: true },
      recentImages: [
        { mimeType: 'image/png', data: 'img0' },
        { mimeType: 'image/png', data: 'img1' }
      ]
    };

    // 1. Force fresh generation ignoring existing thread images
    const freshResult = await tools[0].execute(
      {
        prompt: 'Start from scratch without reference',
        useReferenceImage: false
      },
      context
    );
    assert.equal(capturedOptions.referenceImages, undefined);
    assert.equal(freshResult.usedReferenceImage, false);

    // 2. Select specific reference index 1
    const specificResult = await tools[0].execute(
      {
        prompt: 'Use the older image as reference',
        referenceImageIndex: 1
      },
      context
    );
    assert.ok(capturedOptions.referenceImages);
    assert.equal(capturedOptions.referenceImages[0].data, 'img0'); // Note: after freshResult unshifted, index 1 is img0
    assert.equal(specificResult.usedReferenceImage, true);
  });

  describe('stripImageMetadata', () => {
    function makePngChunk(type: string, data: Buffer): Buffer {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(data.length);
      const typeBuf = Buffer.from(type, 'ascii');
      const crcBuf = Buffer.alloc(4);
      return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
    }

    it('strips all non-critical PNG metadata chunks (tEXt, eXIf, tIME)', async () => {
      const { stripPngMetadata } = await import('../tools/image-tools.js');
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = makePngChunk('IHDR', Buffer.alloc(13));
      const text = makePngChunk('tEXt', Buffer.from('Software\0Nano Banana'));
      const exif = makePngChunk('eXIf', Buffer.from('CameraModelAndGPS'));
      const time = makePngChunk('tIME', Buffer.from('2026-10-17'));
      const idat = makePngChunk('IDAT', Buffer.from('CompressedPixelData'));
      const iend = makePngChunk('IEND', Buffer.alloc(0));

      const mockPng = Buffer.concat([pngHeader, ihdr, text, exif, time, idat, iend]);
      const stripped = stripPngMetadata(mockPng);

      assert.equal(stripped.includes(Buffer.from('tEXt')), false);
      assert.equal(stripped.includes(Buffer.from('eXIf')), false);
      assert.equal(stripped.includes(Buffer.from('tIME')), false);
      assert.equal(stripped.includes(Buffer.from('IHDR')), true);
      assert.equal(stripped.includes(Buffer.from('IDAT')), true);
      assert.equal(stripped.includes(Buffer.from('IEND')), true);
    });

    it('strips JPEG APP1 (EXIF/XMP), APP13 (IPTC), and COM markers', async () => {
      const { stripJpegMetadata } = await import('../tools/image-tools.js');
      const mockJpeg = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xe0, 0x00, 0x04, 0x01, 0x02, // APP0 (JFIF standard)
        0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // APP1 (Exif)
        0xff, 0xfe, 0x00, 0x05, 0x41, 0x49, 0x21, // COM (Comment)
        0xff, 0xda, 0x00, 0x02, // SOS
        0x11, 0x22, 0x33, // Scan data
        0xff, 0xd9 // EOI
      ]);

      const stripped = stripJpegMetadata(mockJpeg);
      assert.equal(stripped.includes(Buffer.from('Exif')), false);
      assert.equal(stripped.includes(Buffer.from([0xff, 0xfe])), false);
      assert.equal(stripped.includes(Buffer.from([0xff, 0xe0])), true);
    });
  });
});

