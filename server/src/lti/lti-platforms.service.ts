import { Injectable } from '@nestjs/common';
import type { Id, LtiPlatform, LtiToolInfo } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db, isUniqueViolation } from '../db/db';
import type { CreatePlatformDto } from './dto';
import { LtiError } from './lti-error';
import { isAllowedPlatformUrl, toolUrls } from './lti-urls';

const UNIQUE_COLUMNS =
  'lti_platforms.issuer, lti_platforms.client_id, lti_platforms.deployment_id';
const COLUMNS =
  'id, name, issuer, client_id, deployment_id, auth_login_url, token_url, jwks_url, created_at';
const URL_FIELDS = [
  ['auth_login_url', 'адреса входу платформи'],
  ['token_url', 'адреса видачі токенів'],
  ['jwks_url', 'адреса набору ключів платформи'],
] as const;

export interface PlatformRow extends LtiPlatform {
  owner_id: Id;
}

@Injectable()
export class LtiPlatformsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  tool(user: AuthUser): LtiToolInfo {
    this.requireTeacher(user);
    return toolUrls();
  }

  list(user: AuthUser): LtiPlatform[] {
    this.requireTeacher(user);
    return this.db.all<LtiPlatform>(
      `SELECT ${COLUMNS} FROM lti_platforms WHERE owner_id = ? ORDER BY id`,
      user.id,
    );
  }

  create(user: AuthUser, dto: CreatePlatformDto): LtiPlatform {
    this.requireTeacher(user);
    for (const [field, label] of URL_FIELDS) {
      if (!isAllowedPlatformUrl(dto[field])) {
        throw badRequest(`Поле ${field}: ${label} має починатися з https://`);
      }
    }
    try {
      const { id } = this.db.run(
        `INSERT INTO lti_platforms
           (owner_id, name, issuer, client_id, deployment_id, auth_login_url, token_url, jwks_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        user.id,
        dto.name,
        dto.issuer,
        dto.client_id,
        dto.deployment_id,
        dto.auth_login_url,
        dto.token_url,
        dto.jwks_url,
        this.clock.now(),
      );
      return this.db.get<LtiPlatform>(
        `SELECT ${COLUMNS} FROM lti_platforms WHERE id = ?`,
        id,
      ) as LtiPlatform;
    } catch (error) {
      if (isUniqueViolation(error, UNIQUE_COLUMNS)) {
        throw conflict('Така платформа вже зареєстрована');
      }
      throw error;
    }
  }

  remove(user: AuthUser, id: Id): void {
    this.requireTeacher(user);
    const { changes } = this.db.run(
      'DELETE FROM lti_platforms WHERE id = ? AND owner_id = ?',
      id,
      user.id,
    );
    if (changes === 0) throw notFound('Платформу не знайдено');
  }

  byId(id: Id): PlatformRow | undefined {
    return this.db.get<PlatformRow>(
      `SELECT owner_id, ${COLUMNS} FROM lti_platforms WHERE id = ?`,
      id,
    );
  }

  /** The platform a login request is about: by issuer, narrowed by client and deployment when given. */
  resolve(issuer: string, clientId: string, deploymentId: string): PlatformRow {
    const found = this.db
      .all<PlatformRow>(
        `SELECT owner_id, ${COLUMNS} FROM lti_platforms WHERE issuer = ? ORDER BY id`,
        issuer,
      )
      .filter(
        (platform) =>
          (clientId === '' || platform.client_id === clientId) &&
          (deploymentId === '' || platform.deployment_id === deploymentId),
      );
    const [platform] = found;
    if (platform === undefined) {
      throw new LtiError(400, 'Цю платформу не зареєстровано на сервері');
    }
    if (found.length > 1) {
      throw new LtiError(
        400,
        'Запит не дозволяє вибрати платформу: вкажіть client_id у налаштуваннях інструменту',
      );
    }
    return platform;
  }

  private requireTeacher(user: AuthUser): void {
    if (user.role !== 'teacher') {
      throw forbidden('Налаштування LMS доступні лише вчителям');
    }
  }
}
