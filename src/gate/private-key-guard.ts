const PRIVATE_KEY_PATTERNS = [
  /0x[a-fA-F0-9]{64}(?=[^a-fA-F0-9]|$)/,
  /-----BEGIN.*PRIVATE KEY-----/,
  /(?:mnemonic|seed|private_key|secret_key|priv_key)\s*[:=]/i,
];

function testPatterns(str: string): boolean {
  return PRIVATE_KEY_PATTERNS.some((p) => p.test(str));
}

export function containsPrivateKeyMaterial(payload: unknown): boolean {
  return testPatterns(JSON.stringify(payload));
}

export function sanitizePayloadForLogging(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  const t = typeof payload;
  if (t === 'number' || t === 'boolean') return payload;
  if (t === 'string') {
    return testPatterns(payload as string)
      ? { _redacted: true, reason: 'potential_private_key_material_detected' }
      : payload;
  }
  const str = JSON.stringify(payload);
  return testPatterns(str)
    ? { _redacted: true, reason: 'potential_private_key_material_detected' }
    : payload;
}
