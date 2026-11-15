import { Injectable } from '@nestjs/common';
import type { LtiJwk } from '@shared/api';
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  SignJWT,
  type CryptoKey,
} from 'jose';
import { randomUUID } from 'node:crypto';
import { Clock } from '../common/clock';
import { Db } from '../db/db';

const ALG = 'RS256';
const ASSERTION_TTL = '5m';

interface ToolKey {
  kid: string;
  jwk: LtiJwk;
  privateKey: CryptoKey;
}

interface KeyRow {
  kid: string;
  private_pem: string;
  public_jwk: string;
}

/** The RSA key pair of this server as an LTI tool: made on first need, kept in the database. */
@Injectable()
export class LtiKeysService {
  private pending: Promise<ToolKey> | undefined;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async publicJwks(): Promise<{ keys: LtiJwk[] }> {
    return { keys: [(await this.key()).jwk] };
  }

  /** The `client_assertion` for the platform's token endpoint (OAuth2 client credentials). */
  async clientAssertion(clientId: string, tokenUrl: string): Promise<string> {
    const { kid, privateKey } = await this.key();
    return new SignJWT({})
      .setProtectedHeader({ alg: ALG, kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(tokenUrl)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(ASSERTION_TTL)
      .sign(privateKey);
  }

  private key(): Promise<ToolKey> {
    this.pending ??= this.loadOrCreate().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private async loadOrCreate(): Promise<ToolKey> {
    const row = this.db.get<KeyRow>(
      'SELECT kid, private_pem, public_jwk FROM lti_tool_keys ORDER BY created_at, rowid LIMIT 1',
    );
    if (row) {
      return {
        kid: row.kid,
        jwk: JSON.parse(row.public_jwk) as LtiJwk,
        privateKey: await importPKCS8(row.private_pem, ALG),
      };
    }
    const pair = await generateKeyPair(ALG, { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    const jwk = { ...publicJwk, kid, alg: ALG, use: 'sig' } as LtiJwk;
    this.db.run(
      'INSERT INTO lti_tool_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)',
      kid,
      await exportPKCS8(pair.privateKey),
      JSON.stringify(jwk),
      this.clock.now(),
    );
    return { kid, jwk, privateKey: pair.privateKey };
  }
}
