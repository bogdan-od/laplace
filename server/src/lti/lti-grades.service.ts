import { Injectable, Logger } from '@nestjs/common';
import type { Id } from '@shared/api';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import {
  JWT_BEARER_ASSERTION,
  PLATFORM_TIMEOUT_MS,
  SCORE_CONTENT_TYPE,
  SCORE_SCOPE,
} from './lti.constants';
import { LtiKeysService } from './lti-keys.service';

interface LinkRow {
  user_id: Id;
  assignment_id: Id;
  sub: string;
  lineitem_url: string;
  client_id: string;
  token_url: string;
}

/** The platform answered, but not with success; the text is shown to the teacher. */
class PlatformRefusal extends Error {}

const REFUSAL_PROBLEM = 'Платформа відповіла помилкою';

function failureText(error: unknown): string {
  if (error instanceof PlatformRefusal) return error.message;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'Платформа не відповіла за 10 с';
  }
  return 'Не вдалося зв’язатися з платформою';
}

/** Sends the teacher's grade to the platform's gradebook (LTI Assignment and Grade Services). */
@Injectable()
export class LtiGradesService {
  private readonly log = new Logger(LtiGradesService.name);
  private readonly tails = new Map<string, Promise<void>>();
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly keys: LtiKeysService,
  ) {}

  /**
   * Marks the link `pending` and sends the grade without waiting for the platform; does nothing
   * when the student did not come through LTI. Never throws and never rejects: a failed transfer
   * is recorded on the link and does not undo the grade.
   */
  queue(studentId: Id, assignmentId: Id, given: number, maximum: number): void {
    const link = this.db.get<LinkRow>(
      `SELECT l.user_id, l.assignment_id, l.sub, l.lineitem_url, p.client_id, p.token_url
       FROM lti_grade_links l JOIN lti_platforms p ON p.id = l.platform_id
       WHERE l.user_id = ? AND l.assignment_id = ?`,
      studentId,
      assignmentId,
    );
    if (!link) return;
    this.mark(link, 'pending', null);
    const key = `${studentId}:${assignmentId}`;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    // Grades of one link go out in the order they were saved.
    const run = (this.tails.get(key) ?? Promise.resolve())
      .then(() => this.deliver(link, given, maximum, key, version))
      .catch((error: unknown) => {
        this.log.error(`LTI grade of user ${studentId} lost: ${String(error)}`);
      });
    this.tails.set(key, run);
    void run.finally(() => {
      if (this.tails.get(key) === run) {
        this.tails.delete(key);
        this.versions.delete(key);
      }
    });
  }

  /** A newer grade of the same link is already queued: this result would only flicker the status. */
  private async deliver(
    link: LinkRow,
    given: number,
    maximum: number,
    key: string,
    version: number,
  ): Promise<void> {
    try {
      await this.send(link, given, maximum);
      if (this.versions.get(key) === version) this.mark(link, 'sent', null);
    } catch (error) {
      const message = failureText(error);
      this.log.warn(
        `LTI grade of user ${link.user_id} for assignment ${link.assignment_id} not sent: ${message}`,
      );
      if (this.versions.get(key) === version)
        this.mark(link, 'failed', message);
    }
  }

  private async send(
    link: LinkRow,
    given: number,
    maximum: number,
  ): Promise<void> {
    const token = await this.accessToken(link);
    const response = await fetch(scoresUrl(link.lineitem_url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': SCORE_CONTENT_TYPE,
      },
      body: JSON.stringify({
        userId: link.sub,
        scoreGiven: given,
        scoreMaximum: maximum,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: new Date(this.clock.now()).toISOString(),
      }),
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new PlatformRefusal(
        `${REFUSAL_PROBLEM} ${response.status} на передачу оцінки`,
      );
    }
  }

  private async accessToken(link: LinkRow): Promise<string> {
    const response = await fetch(link.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: JWT_BEARER_ASSERTION,
        client_assertion: await this.keys.clientAssertion(
          link.client_id,
          link.token_url,
        ),
        scope: SCORE_SCOPE,
      }),
      signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformRefusal(
        `${REFUSAL_PROBLEM} ${response.status} на запит токена`,
      );
    }
    const answer = (await response.json()) as { access_token?: unknown };
    if (typeof answer.access_token !== 'string' || answer.access_token === '') {
      throw new PlatformRefusal('Платформа не видала токен доступу');
    }
    return answer.access_token;
  }

  private mark(
    link: LinkRow,
    status: 'pending' | 'sent' | 'failed',
    error: string | null,
  ): void {
    this.db.run(
      `UPDATE lti_grade_links SET status = ?, error = ?, sent_at = ?
       WHERE user_id = ? AND assignment_id = ?`,
      status,
      error,
      status === 'sent' ? this.clock.now() : null,
      link.user_id,
      link.assignment_id,
    );
  }
}

/** `<lineitem>/scores`; a query string of the line item stays after the path. */
function scoresUrl(lineitem: string): string {
  const url = new URL(lineitem);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/scores`;
  return url.toString();
}
