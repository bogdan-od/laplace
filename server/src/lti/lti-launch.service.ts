import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import { MAX_NAME_CHARS } from '@shared/limits';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { MembershipService } from '../classes/membership.service';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { NO_PASSWORD_HASH } from '../users/password';
import { UsersService } from '../users/users.service';
import {
  CLAIM,
  LEARNER_ROLE,
  LTI_VERSION,
  PLATFORM_TIMEOUT_MS,
  RESOURCE_LINK_REQUEST,
  SCORE_SCOPE,
  TEACHER_ROLES,
} from './lti.constants';
import { LtiError } from './lti-error';
import { LtiPlatformsService, type PlatformRow } from './lti-platforms.service';
import { isAllowedPlatformUrl, toolUrls } from './lti-urls';

const STATE_TTL_MS = 10 * 60_000;
const RANDOM_BYTES = 32;
const CLOCK_TOLERANCE_S = 60;
const LOGIN_HASH_CHARS = 12;

export type LaunchResult =
  | { kind: 'teacher'; ownerId: Id; classId: Id; assignmentId: Id }
  | { kind: 'student'; userId: Id; assignmentId: Id };

interface StateRow {
  nonce: string;
  platform_id: Id;
  expires_at: number;
}

interface AssignmentRow {
  id: Id;
  class_id: Id;
  owner_id: Id;
}

const random = (): string => randomBytes(RANDOM_BYTES).toString('base64url');

/** A request field as trimmed text; anything else (missing, repeated, an object) is empty. */
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JOSE_REFUSALS: Record<string, string> = {
  ERR_JWT_EXPIRED: 'Термін дії токена LTI минув',
  ERR_JWT_CLAIM_VALIDATION_FAILED:
    'Токен LTI видано не для цього інструменту або іншою платформою',
};

/** OIDC login initiation and launch validation of LTI 1.3 (IMS Security Framework). */
@Injectable()
export class LtiLaunchService {
  private readonly keySets = new Map<
    string,
    ReturnType<typeof createRemoteJWKSet>
  >();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly platforms: LtiPlatformsService,
    private readonly users: UsersService,
    private readonly membership: MembershipService,
  ) {}

  /** The address to redirect the browser to: the platform's authentication endpoint. */
  beginLogin(params: Record<string, unknown>): string {
    const issuer = text(params.iss);
    const loginHint = text(params.login_hint);
    if (issuer === '' || loginHint === '') {
      throw new LtiError(400, 'У запиті немає параметрів iss або login_hint');
    }
    const platform = this.platforms.resolve(
      issuer,
      text(params.client_id),
      text(params.lti_deployment_id),
    );
    const state = random();
    const nonce = random();
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run('DELETE FROM lti_states WHERE expires_at <= ?', now);
      this.db.run(
        'INSERT INTO lti_states (state, nonce, platform_id, expires_at) VALUES (?, ?, ?, ?)',
        state,
        nonce,
        platform.id,
        now + STATE_TTL_MS,
      );
    });
    const url = new URL(platform.auth_login_url);
    const query: Record<string, string> = {
      scope: 'openid',
      response_type: 'id_token',
      response_mode: 'form_post',
      prompt: 'none',
      client_id: platform.client_id,
      redirect_uri: toolUrls().launch_url,
      login_hint: loginHint,
      state,
      nonce,
    };
    const messageHint = text(params.lti_message_hint);
    if (messageHint !== '') query.lti_message_hint = messageHint;
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /** Checks the platform's id_token and, for a student, enrols them. */
  async launch(form: Record<string, unknown>): Promise<LaunchResult> {
    const idToken = text(form.id_token);
    const state = text(form.state);
    if (idToken === '' || state === '') {
      throw new LtiError(400, 'У запиті немає id_token або state');
    }
    const saved = this.takeState(state);
    if (!saved) {
      throw new LtiError(
        400,
        'Сеанс входу не знайдено, він застарів або вже використаний',
      );
    }
    const platform = this.platforms.byId(saved.platform_id);
    if (!platform) throw new LtiError(400, 'Платформу видалено');
    const payload = await this.verify(platform, idToken);
    if (payload.nonce !== saved.nonce) {
      throw new LtiError(403, 'Токен LTI не відповідає цьому входу (nonce)');
    }
    if (payload[CLAIM.deploymentId] !== platform.deployment_id) {
      throw new LtiError(
        403,
        'Токен LTI належить іншому розгортанню (deployment)',
      );
    }
    if (
      payload[CLAIM.version] !== LTI_VERSION ||
      payload[CLAIM.messageType] !== RESOURCE_LINK_REQUEST
    ) {
      throw new LtiError(
        403,
        'Підтримується лише запуск LTI 1.3 ресурсу (LtiResourceLinkRequest)',
      );
    }
    const assignment = this.assignmentOf(payload, platform);
    const roles = stringList(payload[CLAIM.roles]);
    if (roles.some((role) => TEACHER_ROLES.has(role))) {
      return {
        kind: 'teacher',
        ownerId: platform.owner_id,
        classId: assignment.class_id,
        assignmentId: assignment.id,
      };
    }
    if (!roles.includes(LEARNER_ROLE)) {
      throw new LtiError(403, 'Роль LTI не підтримується');
    }
    const userId = this.enrol(platform, payload, assignment);
    return { kind: 'student', userId, assignmentId: assignment.id };
  }

  /** The state is single-use: it is gone after the first try, valid or not. */
  private takeState(state: string): StateRow | undefined {
    return this.db.tx(() => {
      const row = this.db.get<StateRow>(
        'SELECT nonce, platform_id, expires_at FROM lti_states WHERE state = ?',
        state,
      );
      if (!row) return undefined;
      this.db.run('DELETE FROM lti_states WHERE state = ?', state);
      return row.expires_at > this.clock.now() ? row : undefined;
    });
  }

  private async verify(
    platform: PlatformRow,
    idToken: string,
  ): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keySetOf(platform), {
        algorithms: ['RS256'],
        issuer: platform.issuer,
        audience: platform.client_id,
        clockTolerance: CLOCK_TOLERANCE_S,
      }));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new LtiError(
        403,
        (typeof code === 'string' ? JOSE_REFUSALS[code] : undefined) ??
          'Підпис токена LTI недійсний',
      );
    }
    if (Array.isArray(payload.aud) && payload.aud.length > 1) {
      if (payload.azp !== platform.client_id) {
        throw new LtiError(
          403,
          'Токен LTI видано для кількох отримувачів без azp цього інструменту',
        );
      }
    }
    return payload;
  }

  private keySetOf(
    platform: PlatformRow,
  ): ReturnType<typeof createRemoteJWKSet> {
    const key = `${platform.id}:${platform.jwks_url}`;
    let keys = this.keySets.get(key);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(platform.jwks_url), {
        timeoutDuration: PLATFORM_TIMEOUT_MS,
      });
      this.keySets.set(key, keys);
    }
    return keys;
  }

  private assignmentOf(
    payload: JWTPayload,
    platform: PlatformRow,
  ): AssignmentRow {
    const custom = payload[CLAIM.custom];
    const raw = isRecord(custom) ? custom.assignment : undefined;
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw new LtiError(
        400,
        'У налаштуваннях активності в LMS не вказано параметр assignment=<id завдання>',
      );
    }
    const id = /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
    const row = Number.isSafeInteger(id)
      ? this.db.get<AssignmentRow>(
          `SELECT a.id, a.class_id, c.owner_id
           FROM assignments a JOIN classes c ON c.id = a.class_id
           WHERE a.id = ? AND a.deleted_at IS NULL AND c.deleted_at IS NULL`,
          id,
        )
      : undefined;
    if (!row || row.owner_id !== platform.owner_id) {
      throw new LtiError(403, 'Завдання не належить власнику цієї платформи');
    }
    return row;
  }

  /** Finds or creates the student, puts them in the class and remembers where to send the grade. */
  private enrol(
    platform: PlatformRow,
    payload: JWTPayload,
    assignment: AssignmentRow,
  ): Id {
    const sub = text(payload.sub);
    if (sub === '')
      throw new LtiError(
        403,
        'У токені LTI немає ідентифікатора користувача (sub)',
      );
    return this.db.tx(() => {
      const known = this.db.get<{ user_id: Id }>(
        'SELECT user_id FROM lti_users WHERE platform_id = ? AND sub = ?',
        platform.id,
        sub,
      );
      let userId = known?.user_id;
      if (userId === undefined) {
        const login = `lti-${platform.id}-${createHash('sha256').update(sub).digest('hex').slice(0, LOGIN_HASH_CHARS)}`;
        userId = this.users.create({
          login,
          name: displayName(payload) || login,
          role: 'student',
          passwordHash: NO_PASSWORD_HASH,
        });
        this.db.run(
          'INSERT INTO lti_users (platform_id, sub, user_id) VALUES (?, ?, ?)',
          platform.id,
          sub,
          userId,
        );
      }
      this.membership.joinAsStudent(assignment.class_id, { id: userId });
      this.linkGrade(platform, payload, assignment.id, userId, sub);
      return userId;
    });
  }

  private linkGrade(
    platform: PlatformRow,
    payload: JWTPayload,
    assignmentId: Id,
    userId: Id,
    sub: string,
  ): void {
    const endpoint = payload[CLAIM.agsEndpoint];
    if (!isRecord(endpoint)) return;
    const lineitem = text(endpoint.lineitem);
    if (
      lineitem === '' ||
      !stringList(endpoint.scope).includes(SCORE_SCOPE) ||
      !isAllowedPlatformUrl(lineitem)
    ) {
      return;
    }
    this.db.run(
      `INSERT INTO lti_grade_links (user_id, assignment_id, platform_id, sub, lineitem_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, assignment_id) DO UPDATE SET lineitem_url = excluded.lineitem_url`,
      userId,
      assignmentId,
      platform.id,
      sub,
      lineitem,
    );
  }
}

function displayName(payload: JWTPayload): string {
  const full =
    text(payload.name) ||
    `${text(payload.given_name)} ${text(payload.family_name)}`.trim();
  return full.slice(0, MAX_NAME_CHARS);
}
