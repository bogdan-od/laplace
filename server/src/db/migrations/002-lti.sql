-- LTI 1.3. Applied by Db to a database whose user_version is below 2.
BEGIN;

CREATE TABLE lti_platforms (
  id             INTEGER PRIMARY KEY,
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  name           TEXT    NOT NULL,
  issuer         TEXT    NOT NULL,
  client_id      TEXT    NOT NULL,
  deployment_id  TEXT    NOT NULL,
  auth_login_url TEXT    NOT NULL,
  token_url      TEXT    NOT NULL,
  jwks_url       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (issuer, client_id, deployment_id)
) STRICT;

-- The key pair of this server as an LTI tool; the private key is PKCS8 PEM and never leaves the database.
CREATE TABLE lti_tool_keys (
  kid         TEXT    PRIMARY KEY,
  private_pem TEXT    NOT NULL,
  public_jwk  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

-- One row per OIDC login in flight; deleted on use.
CREATE TABLE lti_states (
  state       TEXT    PRIMARY KEY,
  nonce       TEXT    NOT NULL,
  platform_id INTEGER NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE lti_users (
  platform_id INTEGER NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  sub         TEXT    NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (platform_id, sub)
) STRICT;

CREATE TABLE lti_grade_links (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  platform_id   INTEGER NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  sub           TEXT    NOT NULL,
  lineitem_url  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error         TEXT,
  sent_at       INTEGER,
  PRIMARY KEY (user_id, assignment_id)
) STRICT;

PRAGMA user_version = 2;
COMMIT;
