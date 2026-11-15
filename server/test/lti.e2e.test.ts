import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type {
  Id,
  LtiJwk,
  LtiPlatform,
  Submission,
  SubmissionSummary,
} from '@shared/api';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';
import {
  evs,
  openAttempt,
  putEvents,
  startBranch,
  world,
} from './attempt-fixtures';
import { body, createTestApp, TestApp, whoAmI, type Client } from './helpers';

const IMS = 'https://purl.imsglobal.org/spec/lti';
const ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/membership';
const LEARNER = `${ROLE}#Learner`;
const INSTRUCTOR = `${ROLE}#Instructor`;
const CLIENT_ID = 'client-1';
const DEPLOYMENT = 'dep-1';
const SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const PLATFORM_KID = 'platform-key';

let t: TestApp;
let platformServer: Server;
let origin: string;
let issuer: string;
let platformKey: CryptoKey;
let platform: LtiPlatform;
let owner: Client;
let assignmentId: Id;
let classId: Id;
let foreignAssignmentId: Id;

/** What the fake platform saw and how it answers the grade. */
const seen = {
  scores: [] as Record<string, unknown>[],
  scoreHeaders: [] as IncomingMessage['headers'][],
  tokenRequests: 0,
  scoreStatus: 200,
  scoreDelayMs: 0,
};

const nowS = (): number => Math.floor(Date.now() / 1000);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const WAIT_LIMIT_MS = 5000;
const WAIT_STEP_MS = 25;

/** The grade goes to the platform in the background: poll the submission until the status changes. */
async function waitForLmsStatus(
  submissionId: Id,
  status: 'sent' | 'failed',
): Promise<Submission> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const current = (
      await owner.get(`/api/submissions/${submissionId}`).expect(200)
    ).body as Submission;
    if (current.lms_grade?.status === status) return current;
    assert.ok(
      Date.now() < deadline,
      `status stayed ${current.lms_grade?.status ?? 'null'}, expected ${status}`,
    );
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

async function toolKeys(): Promise<ReturnType<typeof createLocalJWKSet>> {
  const res = await t.client().get('/api/lti/jwks').expect(200);
  return createLocalJWKSet({ keys: (res.body as { keys: LtiJwk[] }).keys });
}

/** A platform on 127.0.0.1: JWKS, a token endpoint that checks our assertion, and AGS scores. */
async function startPlatform(): Promise<void> {
  const pair = await generateKeyPair('RS256');
  platformKey = pair.privateKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: PLATFORM_KID,
    alg: 'RS256',
    use: 'sig',
  };
  platformServer = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0];
      if (path === '/jwks') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ keys: [jwk] }));
      } else if (path === '/token') {
        seen.tokenRequests++;
        const form = new URLSearchParams(await readBody(request));
        try {
          assert.equal(form.get('grant_type'), 'client_credentials');
          assert.equal(
            form.get('client_assertion_type'),
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          );
          assert.equal(form.get('scope'), SCORE_SCOPE);
          const verified = await jwtVerify(
            form.get('client_assertion') ?? '',
            await toolKeys(),
            {
              algorithms: ['RS256'],
              issuer: CLIENT_ID,
              subject: CLIENT_ID,
              audience: `${origin}/token`,
            },
          );
          assert.ok(verified.payload.jti);
          assert.ok(verified.protectedHeader.kid);
        } catch {
          response.statusCode = 401;
          response.end('{"error":"invalid_client"}');
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            access_token: 'tok-1',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      } else if (path === '/lineitems/5/scores') {
        seen.scoreHeaders.push(request.headers);
        seen.scores.push(
          JSON.parse(await readBody(request)) as Record<string, unknown>,
        );
        if (seen.scoreDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, seen.scoreDelayMs),
          );
        }
        response.statusCode = seen.scoreStatus;
        response.end();
      } else {
        response.statusCode = 404;
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve) =>
    platformServer.listen(0, '127.0.0.1', resolve),
  );
  origin = `http://127.0.0.1:${(platformServer.address() as AddressInfo).port}`;
  issuer = origin;
}

interface TokenOptions {
  sub?: string;
  nonce: string;
  aud?: string | string[];
  azp?: string;
  deployment?: string;
  assignment?: Id | string | null;
  roles?: string[];
  key?: CryptoKey;
  kid?: string;
  issuedAt?: number;
  expiresAt?: number;
  ags?: boolean;
  name?: string | null;
}

async function idToken(options: TokenOptions): Promise<string> {
  const claims: Record<string, unknown> = {
    nonce: options.nonce,
    ...(options.azp ? { azp: options.azp } : {}),
    [`${IMS}/claim/deployment_id`]: options.deployment ?? DEPLOYMENT,
    [`${IMS}/claim/version`]: '1.3.0',
    [`${IMS}/claim/message_type`]: 'LtiResourceLinkRequest',
    [`${IMS}/claim/roles`]: options.roles ?? [LEARNER],
    [`${IMS}/claim/custom`]:
      options.assignment === null
        ? {}
        : { assignment: String(options.assignment ?? assignmentId) },
  };
  if (options.name !== null) claims.name = options.name ?? 'Іван з LMS';
  if (options.ags !== false) {
    claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'] = {
      scope: [SCORE_SCOPE],
      lineitem: `${origin}/lineitems/5`,
    };
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? PLATFORM_KID })
    .setIssuer(issuer)
    .setAudience(options.aud ?? CLIENT_ID)
    .setSubject(options.sub ?? 'lms-user-1')
    .setIssuedAt(options.issuedAt ?? nowS())
    .setExpirationTime(options.expiresAt ?? nowS() + 300)
    .sign(options.key ?? platformKey);
}

/** The unsigned token an attacker would send: alg none, built by hand. */
function unsignedToken(nonce: string): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    iss: issuer,
    aud: CLIENT_ID,
    sub: 'lms-user-1',
    nonce,
    exp: nowS() + 300,
    [`${IMS}/claim/deployment_id`]: DEPLOYMENT,
    [`${IMS}/claim/version`]: '1.3.0',
    [`${IMS}/claim/message_type`]: 'LtiResourceLinkRequest',
    [`${IMS}/claim/roles`]: [LEARNER],
    [`${IMS}/claim/custom`]: { assignment: String(assignmentId) },
  })}.`;
}

/** The first leg: the platform's login request, answered by a redirect carrying state and nonce. */
async function login(
  client: Client,
): Promise<{ state: string; nonce: string; location: URL }> {
  const res = await client
    .get('/api/lti/login')
    .query({
      iss: issuer,
      login_hint: 'hint-1',
      target_link_uri: 'http://localhost/api/lti/launch',
      lti_message_hint: 'message-hint-1',
      client_id: CLIENT_ID,
      lti_deployment_id: DEPLOYMENT,
    })
    .expect(302);
  const location = new URL(res.headers.location as string);
  return {
    state: location.searchParams.get('state') ?? '',
    nonce: location.searchParams.get('nonce') ?? '',
    location,
  };
}

const launchWith = (client: Client, token: string, state: string) =>
  client.post('/api/lti/launch').type('form').send({ id_token: token, state });

/** A full launch of a student; returns the client that holds the session cookie. */
async function studentLaunch(sub = 'lms-user-1'): Promise<Client> {
  const client = t.client();
  const { state, nonce } = await login(client);
  const res = await launchWith(client, await idToken({ nonce, sub }), state);
  assert.equal(res.status, 303, res.text);
  return client;
}

/** The student works on the assignment and submits; returns the submission id. */
async function submitWork(client: Client): Promise<Id> {
  const attempt = await openAttempt(client, assignmentId);
  const start = await startBranch(client, attempt.id);
  await putEvents(client, start.id, 0, evs(0, 4));
  const res = await client
    .post(`/api/attempts/${attempt.id}/submit`)
    .send({ heads: [{ node: 'm1', branch_id: start.id, event_count: 4 }] })
    .expect(201);
  return (res.body as SubmissionSummary).id;
}

function assertRefused(
  res: { status: number; headers: Record<string, unknown>; text: string },
  status: number,
  reason?: RegExp,
): void {
  assert.equal(res.status, status, res.text);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.text, /Не вдалося відкрити завдання/);
  if (reason) assert.match(res.text, reason);
}

const userCount = (): number =>
  t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? -1;

before(async () => {
  process.env.LAPLACE_LTI_ALLOW_HTTP = '1';
  t = await createTestApp();
  await startPlatform();
  const w = await world(t);
  const other = await world(t);
  owner = w.owner;
  assignmentId = w.assignment.id;
  classId = w.classId;
  foreignAssignmentId = other.assignment.id;
  platform = (
    await owner
      .post('/api/lti/platforms')
      .send({
        name: 'Test LMS',
        issuer,
        client_id: CLIENT_ID,
        deployment_id: DEPLOYMENT,
        auth_login_url: `${origin}/auth`,
        token_url: `${origin}/token`,
        jwks_url: `${origin}/jwks`,
      })
      .expect(201)
  ).body as LtiPlatform;
});

after(async () => {
  delete process.env.LAPLACE_LTI_ALLOW_HTTP;
  await new Promise((resolve) => platformServer.close(resolve));
  await t.close();
});

describe('tool and platform registration', () => {
  test('the JWKS is public, has one RS256 key and no private part', async () => {
    const res = await t.client().get('/api/lti/jwks').expect(200);
    const keys = (res.body as { keys: Record<string, unknown>[] }).keys;
    assert.equal(keys.length, 1);
    const [key] = keys;
    assert.equal(key?.kty, 'RSA');
    assert.equal(key?.alg, 'RS256');
    assert.equal(key?.use, 'sig');
    assert.ok(key?.kid);
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi'])
      assert.equal(key?.[secret], undefined);
    assert.deepEqual((await t.client().get('/api/lti/jwks')).body, res.body);
  });

  test('the teacher gets the three addresses; a student and a visitor do not', async () => {
    const tool = body(await owner.get('/api/lti/tool').expect(200));
    assert.equal(tool.login_url, 'http://localhost:8086/api/lti/login');
    assert.equal(tool.launch_url, 'http://localhost:8086/api/lti/launch');
    assert.equal(tool.jwks_url, 'http://localhost:8086/api/lti/jwks');
    await t.client().get('/api/lti/tool').expect(401);
    const student = await studentLaunch('lms-tool-viewer');
    await student.get('/api/lti/tool').expect(403);
    await student.get('/api/lti/platforms').expect(403);
  });

  test('LAPLACE_PUBLIC_URL sets the base of the addresses', async () => {
    process.env.LAPLACE_PUBLIC_URL = 'https://lab.example.org/';
    try {
      const tool = body(await owner.get('/api/lti/tool').expect(200));
      assert.equal(tool.launch_url, 'https://lab.example.org/api/lti/launch');
    } finally {
      delete process.env.LAPLACE_PUBLIC_URL;
    }
  });

  test('only the owner sees and deletes a platform; a duplicate is refused', async () => {
    const stranger = (await world(t)).owner;
    assert.deepEqual(
      (await stranger.get('/api/lti/platforms').expect(200)).body,
      [],
    );
    await stranger.delete(`/api/lti/platforms/${platform.id}`).expect(404);
    const listed = (await owner.get('/api/lti/platforms').expect(200))
      .body as LtiPlatform[];
    assert.ok(listed.some((p) => p.id === platform.id));
    await owner
      .post('/api/lti/platforms')
      .send({ ...platform, id: undefined, created_at: undefined })
      .expect(409);
  });

  test('plain http addresses are refused unless LAPLACE_LTI_ALLOW_HTTP=1', async () => {
    const draft = {
      name: 'Local',
      issuer: 'https://other.example',
      client_id: 'c',
      deployment_id: 'd',
      auth_login_url: 'https://other.example/auth',
      token_url: 'https://other.example/token',
      jwks_url: 'http://other.example/jwks',
    };
    delete process.env.LAPLACE_LTI_ALLOW_HTTP;
    try {
      const res = await owner
        .post('/api/lti/platforms')
        .send(draft)
        .expect(400);
      assert.match(body(res).message as string, /jwks_url/);
      assert.match(body(res).message as string, /https/);
      assert.equal((await owner.get('/api/lti/platforms')).body.length, 1);
      await owner
        .post('/api/lti/platforms')
        .send({ ...draft, jwks_url: 'https://other.example/jwks' })
        .expect(201);
    } finally {
      process.env.LAPLACE_LTI_ALLOW_HTTP = '1';
    }
    await owner
      .post('/api/lti/platforms')
      .send({ ...draft, deployment_id: 'd2' })
      .expect(201);
  });
});

describe('OIDC login', () => {
  test('answers 302 to the platform with state, nonce and the fixed parameters', async () => {
    const { location, state, nonce } = await login(t.client());
    assert.equal(location.origin + location.pathname, `${origin}/auth`);
    const q = location.searchParams;
    assert.equal(q.get('scope'), 'openid');
    assert.equal(q.get('response_type'), 'id_token');
    assert.equal(q.get('response_mode'), 'form_post');
    assert.equal(q.get('prompt'), 'none');
    assert.equal(q.get('client_id'), CLIENT_ID);
    assert.equal(q.get('redirect_uri'), 'http://localhost:8086/api/lti/launch');
    assert.equal(q.get('login_hint'), 'hint-1');
    assert.equal(q.get('lti_message_hint'), 'message-hint-1');
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(state, nonce);
  });

  test('works as a form POST too, and refuses an unknown platform', async () => {
    const res = await t
      .client()
      .post('/api/lti/login')
      .type('form')
      .send({ iss: issuer, login_hint: 'hint-2', client_id: CLIENT_ID })
      .expect(302);
    assert.equal(
      new URL(res.headers.location as string).searchParams.get('login_hint'),
      'hint-2',
    );
    const unknown = await t
      .client()
      .get('/api/lti/login')
      .query({ iss: 'https://nobody.example', login_hint: 'h' });
    assertRefused(unknown, 400);
    assertRefused(
      await t.client().get('/api/lti/login').query({ iss: issuer }),
      400,
    );
  });
});

describe('launch of a student and the grade', () => {
  test('login, launch, enrolment, grading and the score in the platform', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    const res = await launchWith(client, await idToken({ nonce }), state);
    assert.equal(res.status, 303, res.text);
    assert.equal(res.headers.location, `/assignments/${assignmentId}`);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    assert.match(cookie, /sid=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);

    const me = await whoAmI(client);
    assert.equal(me.role, 'student');
    assert.equal(me.name, 'Іван з LMS');
    assert.match(me.login, new RegExp(`^lti-${platform.id}-[0-9a-f]{12}$`));
    const classes = (await client.get('/api/classes').expect(200)).body as {
      id: Id;
    }[];
    assert.deepEqual(
      classes.map((c) => c.id),
      [classId],
    );
    const mine = (await client.get('/api/me/assignments').expect(200)).body as {
      id: Id;
    }[];
    assert.deepEqual(
      mine.map((a) => a.id),
      [assignmentId],
    );
    await client
      .post('/api/auth/login')
      .send({ login: me.login, password: 'password123' })
      .expect(401);
    await client
      .post('/api/auth/login')
      .send({ login: me.login, password: '!' })
      .expect(401);

    const submissionId = await submitWork(client);
    const before = (
      await owner.get(`/api/submissions/${submissionId}`).expect(200)
    ).body as Submission;
    assert.equal(before.lms_grade?.status, 'pending');
    assert.equal(seen.scores.length, 0);

    const graded = (
      await owner
        .put(`/api/submissions/${submissionId}/grade`)
        .send({ grade: 8, note: 'Добре' })
        .expect(200)
    ).body as Submission;
    assert.equal(graded.grade, 8);
    assert.equal(graded.lms_grade?.status, 'pending');
    const sent = await waitForLmsStatus(submissionId, 'sent');
    assert.equal(sent.lms_grade?.error, null);
    assert.ok(sent.lms_grade?.sent_at);
    assert.equal(seen.scores.length, 1);
    const [score] = seen.scores;
    assert.equal(score?.userId, 'lms-user-1');
    assert.equal(score?.scoreGiven, 8);
    assert.equal(score?.scoreMaximum, 10);
    assert.equal(score?.activityProgress, 'Completed');
    assert.equal(score?.gradingProgress, 'FullyGraded');
    assert.equal(score?.timestamp, new Date(t.clock.current).toISOString());
    assert.equal(seen.scoreHeaders[0]?.authorization, 'Bearer tok-1');
    assert.equal(
      seen.scoreHeaders[0]?.['content-type'],
      'application/vnd.ims.lis.v1.score+json',
    );

    const asStudent = (
      await client.get(`/api/submissions/${submissionId}`).expect(200)
    ).body as Submission;
    assert.equal(asStudent.lms_grade, null);
  });

  test('the same sub comes back as the same user, in the class once', async () => {
    const first = await whoAmI(await studentLaunch('lms-user-2'));
    const again = await whoAmI(await studentLaunch('lms-user-2'));
    assert.equal(again.id, first.id);
    const members = t.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND user_id = ?',
      classId,
      first.id,
    );
    assert.equal(members?.n, 1);
    const other = await whoAmI(await studentLaunch('lms-user-3'));
    assert.notEqual(other.id, first.id);
  });

  test('the name falls back to given and family name, then to the login', async () => {
    for (const [sub, name, expected] of [
      ['lms-n1', null, /^lti-/],
      ['lms-n2', 'Марія', /^Марія$/],
    ] as const) {
      const client = t.client();
      const { state, nonce } = await login(client);
      await launchWith(
        client,
        await idToken({ nonce, sub, name }),
        state,
      ).expect(303);
      assert.match((await whoAmI(client)).name, expected);
    }
  });

  test('a failing platform does not undo the grade: status failed, then sent on the next save', async () => {
    const client = await studentLaunch('lms-user-4');
    const submissionId = await submitWork(client);
    seen.scoreStatus = 500;
    try {
      const saved = (
        await owner
          .put(`/api/submissions/${submissionId}/grade`)
          .send({ grade: 6 })
          .expect(200)
      ).body as Submission;
      assert.equal(saved.grade, 6);
      const failed = await waitForLmsStatus(submissionId, 'failed');
      assert.equal(failed.lms_grade?.status, 'failed');
      assert.match(failed.lms_grade?.error ?? '', /500/);
      assert.doesNotMatch(failed.lms_grade?.error ?? '', /tok-1/);
      assert.equal(failed.lms_grade?.sent_at, null);
    } finally {
      seen.scoreStatus = 200;
    }
    const kept = (
      await owner.get(`/api/submissions/${submissionId}`).expect(200)
    ).body as Submission;
    assert.equal(kept.grade, 6);
    const retry = (
      await owner
        .put(`/api/submissions/${submissionId}/grade`)
        .send({ grade: 7 })
        .expect(200)
    ).body as Submission;
    assert.equal(retry.lms_grade?.status, 'pending');
    await waitForLmsStatus(submissionId, 'sent');
  });

  test('an unreachable token endpoint is a recorded failure too', async () => {
    const client = await studentLaunch('lms-user-5');
    const submissionId = await submitWork(client);
    const link = t.db.get<{ platform_id: Id }>(
      'SELECT platform_id FROM lti_grade_links WHERE sub = ?',
      'lms-user-5',
    );
    assert.equal(link?.platform_id, platform.id);
    t.db.run(
      'UPDATE lti_platforms SET token_url = ? WHERE id = ?',
      'http://127.0.0.1:1/token',
      platform.id,
    );
    try {
      await owner
        .put(`/api/submissions/${submissionId}/grade`)
        .send({ grade: 5 })
        .expect(200);
      const res = await waitForLmsStatus(submissionId, 'failed');
      assert.ok(res.lms_grade?.error);
    } finally {
      t.db.run(
        'UPDATE lti_platforms SET token_url = ? WHERE id = ?',
        `${origin}/token`,
        platform.id,
      );
    }
  });

  test('a slow platform does not hold the answer: pending at once, sent later', async () => {
    const client = await studentLaunch('lms-user-7');
    const submissionId = await submitWork(client);
    const before = seen.scores.length;
    seen.scoreDelayMs = 3000;
    try {
      const started = Date.now();
      const res = (
        await owner
          .put(`/api/submissions/${submissionId}/grade`)
          .send({ grade: 4 })
          .expect(200)
      ).body as Submission;
      assert.ok(
        Date.now() - started < 1000,
        'the answer waited for the platform',
      );
      assert.equal(res.grade, 4);
      assert.equal(res.lms_grade?.status, 'pending');
      const sent = await waitForLmsStatus(submissionId, 'sent');
      assert.ok(Date.now() - started >= 3000);
      assert.equal(sent.lms_grade?.error, null);
      assert.equal(seen.scores.length, before + 1);
    } finally {
      seen.scoreDelayMs = 0;
    }
  });

  test('two quick saves: both go out in order, the status follows the last one', async () => {
    const client = await studentLaunch('lms-user-8');
    const submissionId = await submitWork(client);
    const before = seen.scores.length;
    for (const grade of [3, 9]) {
      await owner
        .put(`/api/submissions/${submissionId}/grade`)
        .send({ grade })
        .expect(200);
    }
    const sent = await waitForLmsStatus(submissionId, 'sent');
    assert.equal(sent.grade, 9);
    assert.deepEqual(
      seen.scores.slice(before).map((score) => score.scoreGiven),
      [3, 9],
    );
  });

  test('without the AGS claim there is nothing to send', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    await launchWith(
      client,
      await idToken({ nonce, sub: 'lms-user-6', ags: false }),
      state,
    ).expect(303);
    const submissionId = await submitWork(client);
    const before = seen.scores.length;
    const res = (
      await owner
        .put(`/api/submissions/${submissionId}/grade`)
        .send({ grade: 9 })
        .expect(200)
    ).body as Submission;
    assert.equal(res.lms_grade, null);
    assert.equal(seen.scores.length, before);
  });
});

describe('launch of a teacher', () => {
  test('is a redirect without a session; a visitor goes through the site login', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    const users = userCount();
    const res = await launchWith(
      client,
      await idToken({ nonce, roles: [LEARNER, INSTRUCTOR] }),
      state,
    );
    assert.equal(res.status, 303);
    assert.equal(
      res.headers.location,
      `/login?next=${encodeURIComponent(`/classes/${classId}?a=${assignmentId}`)}`,
    );
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(userCount(), users);
  });

  test('the signed-in owner goes straight to the assignment of the class', async () => {
    const { state, nonce } = await login(owner);
    const res = await launchWith(
      owner,
      await idToken({ nonce, roles: [INSTRUCTOR] }),
      state,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `/classes/${classId}?a=${assignmentId}`);
  });
});

describe('launch refusals', () => {
  test('a token signed with a foreign key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const client = t.client();
    const { state, nonce } = await login(client);
    assertRefused(
      await launchWith(
        client,
        await idToken({ nonce, key: privateKey }),
        state,
      ),
      403,
      /Підпис токена LTI недійсний/,
    );
  });

  test('alg none', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    assertRefused(
      await launchWith(client, unsignedToken(nonce), state),
      403,
      /Підпис токена LTI недійсний/,
    );
  });

  test('a wrong audience, and several audiences without our azp', async () => {
    const client = t.client();
    for (const options of [
      { aud: 'someone-else' },
      { aud: [CLIENT_ID, 'other'] },
    ]) {
      const { state, nonce } = await login(client);
      assertRefused(
        await launchWith(client, await idToken({ nonce, ...options }), state),
        403,
        /видано (не для цього інструменту|для кількох отримувачів)/,
      );
    }
    const { state, nonce } = await login(client);
    const ok = await launchWith(
      client,
      await idToken({ nonce, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }),
      state,
    );
    assert.equal(ok.status, 303);
  });

  test('a state works once; an unknown or expired state is refused', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    const token = await idToken({ nonce });
    assert.equal((await launchWith(client, token, state)).status, 303);
    assertRefused(await launchWith(client, token, state), 400);
    assertRefused(await launchWith(client, token, 'no-such-state'), 400);
    assertRefused(
      await client
        .post('/api/lti/launch')
        .type('form')
        .send({ id_token: token }),
      400,
    );

    const late = await login(client);
    t.clock.advance(11 * 60_000);
    assertRefused(
      await launchWith(
        client,
        await idToken({ nonce: late.nonce }),
        late.state,
      ),
      400,
    );
  });

  test('the state is burnt even when the token is bad', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    assertRefused(
      await launchWith(client, await idToken({ nonce: 'wrong' }), state),
      403,
      /nonce/,
    );
    assertRefused(
      await launchWith(client, await idToken({ nonce }), state),
      400,
    );
  });

  test('a nonce that is not the saved one', async () => {
    const client = t.client();
    const { state } = await login(client);
    assertRefused(
      await launchWith(
        client,
        await idToken({ nonce: 'another-nonce' }),
        state,
      ),
      403,
      /nonce/,
    );
  });

  test('an expired token', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    const token = await idToken({
      nonce,
      issuedAt: nowS() - 7200,
      expiresAt: nowS() - 3600,
    });
    assertRefused(await launchWith(client, token, state), 403, /Термін дії/);
  });

  test('another deployment', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    assertRefused(
      await launchWith(
        client,
        await idToken({ nonce, deployment: 'dep-9' }),
        state,
      ),
      403,
      /deployment/,
    );
  });

  test('an assignment of another teacher, a missing or a bad assignment id', async () => {
    const client = t.client();
    const users = userCount();
    for (const assignment of [
      foreignAssignmentId,
      999_999,
      'abc',
      null,
    ] as const) {
      const { state, nonce } = await login(client);
      const res = await launchWith(
        client,
        await idToken({ nonce, assignment }),
        state,
      );
      assertRefused(res, assignment === null ? 400 : 403);
      if (assignment === foreignAssignmentId) {
        assert.match(res.text, /Завдання не належить власнику цієї платформи/);
      }
    }
    assert.equal(userCount(), users);
  });

  test('a role that is neither teacher nor learner', async () => {
    const client = t.client();
    const { state, nonce } = await login(client);
    const res = await launchWith(
      client,
      await idToken({ nonce, roles: [`${ROLE}#Mentor`] }),
      state,
    );
    assertRefused(res, 403);
    assert.match(res.text, /Роль LTI не підтримується/);
  });
});

describe('deleting a platform', () => {
  test('the owner can delete a platform', async () => {
    const mine = (await owner.get('/api/lti/platforms').expect(200))
      .body as LtiPlatform[];
    const extra = mine.find((p) => p.deployment_id === 'd2');
    assert.ok(extra);
    await owner.delete(`/api/lti/platforms/${extra.id}`).expect(200);
    assert.ok(
      !((await owner.get('/api/lti/platforms')).body as LtiPlatform[]).some(
        (p) => p.id === extra.id,
      ),
    );
  });
});
