import crypto from 'node:crypto';

export const DESCRIPTOR_TYPE = 'dsh-mobile-iroh-pairing';

function splitEndpointId(endpointId) {
  if (!/^[a-f0-9]{64}$/.test(endpointId)) throw new Error('bad endpointId');
  return [endpointId.slice(0, 32), endpointId.slice(32)];
}

export function irohHostname(endpointId) {
  const [a, b] = splitEndpointId(endpointId);
  return `${a}.${b}.iroh.localhost`;
}

export function irohOrigin(endpointId, localPort) {
  return `https://${irohHostname(endpointId)}:${localPort}`;
}

export function caFingerprint(caDer) {
  return crypto.createHash('sha256').update(caDer).digest('hex');
}

export function opaqueToken() {
  return crypto.randomBytes(32).toString('base64url'); // 43 字符
}

/**
 * 生成 App 能解析的配对描述符。字段顺序固定、扁平 JSON、≤2200 字节。
 * 参考 dsh-mobile src/iroh-pairing.ts 的 FIELDS。
 */
export function buildDescriptor({ endpointId, localPort, irohCode, gatewayToken, caDer, expiresAt }) {
  if (!/^[0-9]{6}$/.test(irohCode)) throw new Error('irohCode must be 6 digits');
  if (!/^[A-Za-z0-9_-]{43}$/.test(gatewayToken)) throw new Error('gatewayToken must be 43 base64url chars');
  if (expiresAt <= Date.now() || expiresAt > Date.now() + 600_000) throw new Error('expiresAt out of window');
  const descriptor = {
    version: 1,
    type: DESCRIPTOR_TYPE,
    endpointId,
    origin: irohOrigin(endpointId, localPort),
    localPort,
    irohCode,
    gatewayToken,
    caCertificate: caDer.toString('base64'),
    instanceId: caFingerprint(caDer),
    expiresAt,
  };
  const text = JSON.stringify(descriptor);
  if (Buffer.byteLength(text, 'utf8') > 2200) throw new Error('descriptor too large for QR');
  return { text, descriptor };
}
