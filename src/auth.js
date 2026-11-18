// ---------------------------------------------------------------
// Who is calling? Every /api route needs a valid Cognito token.
//
// 1. Behind API Gateway with the JWT authorizer, the gateway has already
//    checked the token and passes its claims in the request context.
// 2. Otherwise (a PC, or a Floci gateway without authorizers) we check the
//    token ourselves against Cognito's public keys (JWKS).
//
// The user id is ALWAYS the token's "sub". The role is ALWAYS the token's
// "cognito:groups". Nothing the client puts in the body or URL can change them.
// ---------------------------------------------------------------
const { JwtRsaVerifier } = require('aws-jwt-verify');
const { SimpleJwksCache } = require('aws-jwt-verify/jwk');

// The library only fetches keys over https. Floci serves them over http on
// our own machine, so http is allowed ONLY when ALLOW_HTTP_JWKS=true (Floci).
function keysFetcher(allowHttp) {
    return {
        async fetch(uri) {
            if (!uri.startsWith('https://') && !(allowHttp && uri.startsWith('http://'))) {
                throw new Error('JWKS must be fetched over https.');
            }
            const res = await fetch(uri, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) throw new Error(`JWKS fetch failed (${res.status}).`);
            return res.arrayBuffer();          // the library parses and checks the keys itself
        }
    };
}

function createVerifier({
    issuer = process.env.COGNITO_ISSUER,
    jwksUri = process.env.COGNITO_JWKS_URI,
    clientId = process.env.COGNITO_CLIENT_ID
} = {}) {
    if (!issuer || !jwksUri) {
        throw new Error('COGNITO_ISSUER and COGNITO_JWKS_URI must be set to check tokens.');
    }
    // Access tokens carry client_id (not aud), so audience and token_use are checked by hand below.
    const allowHttp = process.env.ALLOW_HTTP_JWKS === 'true';
    const verifier = JwtRsaVerifier.create(
        { issuer, jwksUri, audience: null },
        { jwksCache: new SimpleJwksCache({ fetcher: keysFetcher(allowHttp) }) }
    );
    return async (token) => {
        const claims = await verifier.verify(token);     // signature, expiry, issuer
        if (claims.token_use !== 'access') throw new Error('Only access tokens are accepted.');
        if (clientId && claims.client_id !== clientId) throw new Error('Token is for another app client.');
        return claims;
    };
}

function claimsFromGateway(req) {
    // serverless-http keeps the Lambda event's requestContext on req
    return req.requestContext?.authorizer?.jwt?.claims || null;
}

function toUser(claims) {
    let groups = claims['cognito:groups'] || [];
    if (typeof groups === 'string') groups = groups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
    return { id: claims.sub, groups };
}

function requireUser(verify) {
    return async (req, res, next) => {
        try {
            const fromGateway = claimsFromGateway(req);
            if (fromGateway?.sub) {
                req.user = toUser(fromGateway);
                return next();
            }
            const header = req.get('authorization') || '';
            const match = header.match(/^Bearer (.+)$/);
            if (!match) return unauthorized(req, res, 'missing token');
            const claims = await verify(match[1]);
            req.user = toUser(claims);
            return next();
        } catch (error) {
            return unauthorized(req, res, 'invalid token');
        }
    };
}

function unauthorized(req, res, reason) {
    // Security log line: never the token itself
    console.log(JSON.stringify({ security: 'auth_failed', reason, method: req.method, path: req.baseUrl + req.path }));
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Log in to continue.' } });
}

module.exports = { createVerifier, requireUser, toUser };
