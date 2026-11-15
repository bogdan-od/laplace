const IMS = 'https://purl.imsglobal.org/spec';
const LIS_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2';

export const CLAIM = {
  deploymentId: `${IMS}/lti/claim/deployment_id`,
  version: `${IMS}/lti/claim/version`,
  messageType: `${IMS}/lti/claim/message_type`,
  roles: `${IMS}/lti/claim/roles`,
  custom: `${IMS}/lti/claim/custom`,
  agsEndpoint: `${IMS}/lti-ags/claim/endpoint`,
} as const;

export const LTI_VERSION = '1.3.0';
export const RESOURCE_LINK_REQUEST = 'LtiResourceLinkRequest';
export const SCORE_SCOPE = `${IMS}/lti-ags/scope/score`;
export const SCORE_CONTENT_TYPE = 'application/vnd.ims.lis.v1.score+json';
export const JWT_BEARER_ASSERTION =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A user with any of these roles is a teacher, even when the platform also lists Learner. */
export const TEACHER_ROLES: ReadonlySet<string> = new Set([
  `${LIS_ROLE}/membership#Instructor`,
  `${LIS_ROLE}/membership#Administrator`,
  `${LIS_ROLE}/institution/person#Administrator`,
  `${LIS_ROLE}/membership#ContentDeveloper`,
]);
export const LEARNER_ROLE = `${LIS_ROLE}/membership#Learner`;

/** Timeout of every request this server makes to a platform. */
export const PLATFORM_TIMEOUT_MS = 10_000;
