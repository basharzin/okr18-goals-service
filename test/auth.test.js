// Real token checking: a local JWKS server over http (like Floci) and RS256 tokens
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createVerifier } = require('../src/auth');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, key = privateKey) {
    const body = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
    return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

test('Cognito token check against an http JWKS (Floci style)', async (t) => {
    const srv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); }).listen(0);
    t.after(() => srv.close());
    const port = srv.address().port;
    const issuer = `http://localhost:${port}/us-east-1_pool`;
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'u1', iss: issuer, token_use: 'access', client_id: 'web', exp: now + 600, iat: now, 'cognito:groups': ['user'] };
    const opts = { issuer, jwksUri: `http://127.0.0.1:${port}/.well-known/jwks.json`, clientId: 'web' };

    process.env.ALLOW_HTTP_JWKS = 'false';
    await assert.rejects(createVerifier(opts)(sign(claims)), /https/);          // http refused unless allowed

    process.env.ALLOW_HTTP_JWKS = 'true';
    const verify = createVerifier(opts);
    assert.equal((await verify(sign(claims))).sub, 'u1');
    await assert.rejects(verify(sign(claims, otherKey)));                        // signed by someone else
    await assert.rejects(verify(sign({ ...claims, exp: now - 10 })));            // expired
    await assert.rejects(verify(sign({ ...claims, iss: 'http://evil/pool' })));  // wrong issuer
    await assert.rejects(verify(sign({ ...claims, client_id: 'other-app' })));   // another app's token
    await assert.rejects(verify(sign({ ...claims, token_use: 'id' })));          // an id token, not access
    delete process.env.ALLOW_HTTP_JWKS;
});
