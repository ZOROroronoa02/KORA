import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.KORA_CSP_TEST_URL?.replace(/\/$/, "");

test("production pages receive a fresh CSP nonce on every rendered script", { skip: !baseUrl }, async () => {
  let firstRootNonce;

  for (const path of ["/", "/join", "/kds"]) {
    const response = await fetch(`${baseUrl}${path}`);
    const html = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);

    assert.equal(response.status, 200, `${path} must render successfully`);
    assert.ok(nonce, `${path} must receive a CSP nonce`);
    assert.ok(policy.includes("default-src 'self'"));
    assert.ok(policy.includes("'strict-dynamic'"));
    assert.ok(policy.includes("https://fonts.googleapis.com"));
    assert.ok(policy.includes("https://fonts.gstatic.com"));
    assert.equal(policy.includes("'unsafe-inline'"), false, `${path} must not allow inline production styles or scripts`);
    assert.equal(policy.includes("'unsafe-eval'"), false, `${path} must not allow eval`);
    assert.ok(response.headers.get("strict-transport-security"), `${path} must include HSTS in production`);
    assert.ok(response.headers.get("x-content-type-options"), `${path} must disable MIME sniffing`);
    assert.ok(scripts.length > 0, `${path} must render its Next.js scripts`);
    assert.ok(scripts.every((tag) => tag.includes(`nonce="${nonce}"`)), `${path} must nonce every script with the response nonce`);
    assert.equal(/\sstyle=/.test(html), false, `${path} must not rely on inline style attributes`);

    if (path === "/") firstRootNonce = nonce;
    if (path === "/join") assert.notEqual(nonce, firstRootNonce, "separate page requests must not reuse a nonce");
  }

  const health = await fetch(`${baseUrl}/api/health/live`);
  assert.equal(health.status, 200, "liveness endpoint must remain available");
  assert.ok(health.headers.get("x-content-type-options"), "API routes keep the shared security headers");
  assert.equal(health.headers.get("content-security-policy"), null, "document CSP is not required on JSON endpoints");
});
