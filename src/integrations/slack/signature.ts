import crypto from 'node:crypto';

export interface VerifySlackSignatureOptions {
  signingSecret?: string;
  timestamp?: string | string[];
  signature?: string | string[];
  rawBody?: string | Buffer;
}

export interface VerifySlackSignatureResult {
  valid: boolean;
  reason?: string;
}

export function verifySlackSignature(opts: VerifySlackSignatureOptions): VerifySlackSignatureResult {
  const secret = opts.signingSecret || process.env.SLACK_SIGNING_SECRET;

  if (!secret) {
    return { valid: false, reason: 'SLACK_SIGNING_SECRET is not configured' };
  }

  const timestampHeader = Array.isArray(opts.timestamp) ? opts.timestamp[0] : opts.timestamp;
  const signatureHeader = Array.isArray(opts.signature) ? opts.signature[0] : opts.signature;

  if (!timestampHeader || !signatureHeader) {
    return { valid: false, reason: 'Missing timestamp or signature headers' };
  }

  const reqTimestamp = parseInt(timestampHeader, 10);
  if (isNaN(reqTimestamp)) {
    return { valid: false, reason: 'Invalid timestamp header' };
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTimestamp - reqTimestamp) > 300) {
    return { valid: false, reason: 'Request timestamp is stale (>5m)' };
  }

  if (!signatureHeader.startsWith('v0=')) {
    return { valid: false, reason: 'Invalid signature format' };
  }

  const bodyStr = Buffer.isBuffer(opts.rawBody)
    ? opts.rawBody.toString('utf8')
    : (typeof opts.rawBody === 'string' ? opts.rawBody : '');

  const sigBasestring = `v0:${timestampHeader}:${bodyStr}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(sigBasestring, 'utf8');
  const calculatedSignature = `v0=${hmac.digest('hex')}`;

  const sigBuffer = Buffer.from(signatureHeader, 'utf8');
  const calcBuffer = Buffer.from(calculatedSignature, 'utf8');

  if (sigBuffer.length !== calcBuffer.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  const isMatch = crypto.timingSafeEqual(sigBuffer, calcBuffer);
  return { valid: isMatch, reason: isMatch ? undefined : 'Signature mismatch' };
}
