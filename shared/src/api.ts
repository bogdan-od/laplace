// HTTP API contract between web/ and server/. Both sides import these types, so a field name
// mismatch is a compile error. Change the contract only here.
// Time is ms since the Unix epoch by the server clock. Texts meant for people are Ukrainian.

import type { Journal, JournalEvent, JournalHeader } from "../../app/core/journal.mjs";
import type { Topology } from "../../app/net/topology.mjs";

export type { Journal, JournalEvent, JournalHeader, Topology };

export type Id = number;
export type Ms = number;

/** Body of any 4xx/5xx response (Nest exception format). message is shown to the user. */
export interface ApiError {
  statusCode: number;
  message: string;
  /** Machine-readable code for cases the client handles specially. */
  code?: ApiErrorCode;
}
export type ApiErrorCode =
  | "not_logged_in"
  | "bad_invite"
  | "login_taken"
  | "chunk_gap"          // PUT events: from != branch event_count; the body carries event_count
  | "journal_too_large"
  | "journal_invalid"    // check_journal_strict or c/w monotonicity; message is the core's text
  | "topology_invalid";  // validate_topology; message joins all messages with "; "

// Users and login

export type Role = "teacher" | "student";

export interface Me {
  id: Id;
  login: string;
  name: string;
  role: Role;
}

export interface LoginBody { login: string; password: string }

/** A student registers only with an invite code; a teacher without one. */
export interface RegisterBody {
  login: string;
  password: string;
  name: string;
  role: Role;
  invite_code?: string;
}

export interface PatchMeBody {
  name?: string;
  password?: { old: string; new: string };
}

export interface InviteInfo {
  code: string;
  class_name: string;
  subject: string;
  teacher_name: string;
}

// Classes

export type ClassRole = "owner" | "assistant" | "student";
export type MemberRole = "student" | "assistant";

export interface ClassSummary {
  id: Id;
  name: string;
  subject: string;
  my_role: ClassRole;
  students: number;
  /** Ungraded submissions (0 for a student). */
  to_review: number;
  /** Open help requests (0 for a student). */
  open_help: number;
  next_due_at: Ms | null;
  is_demo: boolean;
}

export interface Member {
  user_id: Id;
  name: string;
  login: string;
  role: MemberRole;
  number: number | null;
  joined_at: Ms;
  last_seen_at: Ms | null;
}

export interface ClassDetail extends ClassSummary {
  owner: { id: Id; name: string };
  /** null for a student. */
  invite_code: string | null;
  /** Empty for a student. */
  members: Member[];
  assignments: AssignmentSummary[];
}

export interface CreateClassBody { name: string; subject: string }
export interface PatchClassBody { name?: string; subject?: string }

/** CSV lines: "full name" or "full name;login" (separator ; or ,). The server generates missing logins. */
export interface ImportCsvBody { csv: string }
export interface ImportedStudent { name: string; login: string; number: number; password: string }
export interface ImportResult {
  /** Passwords are shown once; the server does not store them in plain text. */
  created: ImportedStudent[];
  errors: { line: number; message: string }[];
}

export interface AddAssistantBody { login: string }

// Library and assignments

export type ItemKind = "task" | "lesson" | "clip";
export type JournalRole = "start" | "reference";

/** A teacher's check command, run through the system channel of machine `node`. */
export interface CheckCommand { node: string; title: string; command: string }
export interface Hint { text: string; penalty: number }

export interface JournalRef { node: string; role: JournalRole; size: number }

export interface LibraryItemSummary {
  id: Id;
  kind: ItemKind;
  title: string;
  machines: number;
  updated_at: Ms;
  assigned: { class_id: Id; class_name: string; assignment_id: Id }[];
}

export interface LibraryItem {
  id: Id;
  kind: ItemKind;
  title: string;
  brief: string;
  topology: Topology;
  checks: CheckCommand[];
  hints: Hint[];
  journals: JournalRef[];
  clip_from_ms: number | null;
  embed_token: string | null;
  created_at: Ms;
  updated_at: Ms;
}

export interface CreateItemBody {
  kind: ItemKind;
  title: string;
  brief?: string;
  topology: Topology;
}

export interface PatchItemBody {
  title?: string;
  brief?: string;
  topology?: Topology;
  checks?: CheckCommand[];
  hints?: Hint[];
  clip_from_ms?: number | null;
}

/** Lesson from a submission: the journal of machine `node` becomes a kind = lesson item. */
export interface LessonFromSubmissionBody { submission_id: Id; node: string }

/** Clip: the branch journal up to event to_event, shown from guest time from_ms. */
export interface ClipBody { branch_id: Id; to_event: number; from_ms: number; title: string }

export interface AssignBody {
  class_id: Id;
  due_at: Ms | null;
  max_grade: number;
  shared_lan: boolean;
}

export type TileStatus = "stuck" | "work" | "done" | "idle";

export interface AssignmentSummary {
  id: Id;
  class_id: Id;
  kind: "task" | "lesson";
  title: string;
  due_at: Ms | null;
  max_grade: number;
  created_at: Ms;
  /** For a student counts is empty and my_status holds their own status. */
  counts: Partial<Record<TileStatus, number>>;
  my_status: TileStatus | null;
  /** Grade of the student's latest submission; null for a teacher or when ungraded. */
  my_grade: number | null;
}

/** An assignment on the student's home page: every class where the user is a student. */
export interface MyAssignment extends AssignmentSummary {
  class_name: string;
  /** The teacher froze the assignment: the student cannot work in it for now. */
  frozen: boolean;
}

/** A hint as a student sees it: text is null until opened. */
export interface HintSlot { index: number; penalty: number; text: string | null }

export interface Assignment extends AssignmentSummary {
  /** The library item the assignment was copied from. */
  item_id: Id;
  class_name: string;
  brief: string;
  topology: Topology;
  hints: HintSlot[];
  /** null for a student. */
  checks: CheckCommand[] | null;
  /** A student sees only role = start. */
  journals: JournalRef[];
  shared_lan: boolean;
  frozen: boolean;
  my_attempt_id: Id | null;
}

export interface PatchAssignmentBody {
  title?: string;
  brief?: string;
  due_at?: Ms | null;
  max_grade?: number;
  checks?: CheckCommand[];
}

// Attempts, branches, journal chunks

export type BranchKind = "start" | "rollback" | "continue" | "reply";

export interface UserRef { id: Id; name: string }

export interface Branch {
  id: Id;
  node: string;
  parent_id: Id | null;
  fork_event: number;
  kind: BranchKind;
  author: UserRef;
  event_count: number;
  bytes: number;
  created_at: Ms;
  updated_at: Ms;
}

/** A branch with its attempt, for the player. A student gets no teacher_inputs. */
export interface BranchDetail {
  branch: Branch;
  attempt_id: Id;
  assignment: { id: Id; title: string; class_id: Id };
  student: UserRef;
  /** Node id of the machine the branch belongs to. */
  machine: string;
  /** Every request of the attempt; the player takes those of its branch. */
  help_requests: HelpRequest[];
  /** The log of the assignment for this student (the server keeps it per assignment and student). */
  teacher_inputs: TeacherInput[];
}

export interface Attempt {
  id: Id;
  assignment_id: Id;
  user: UserRef;
  variant: number;
  is_preview: boolean;
  created_at: Ms;
  completed_at: Ms | null;
  /** node -> current branch id. */
  heads: Record<string, Id>;
  branches: Branch[];
  help: HelpRequest[];
  submissions: SubmissionSummary[];
  hints_used: number[];
}

export interface CreateBranchBody {
  node: string;
  /** null only for kind = start (the machine's first branch). */
  parent: { branch_id: Id; event: number } | null;
  kind: BranchKind;
  header: JournalHeader;
  /** true: the branch becomes the head of node (student's start, rollback, continue). */
  make_head: boolean;
}

export interface AppendEventsBody {
  /** Index of the chunk's first event in the full journal; must equal the branch event_count. */
  from: number;
  events: JournalEvent[];
  /** For the teacher's tile; the server does not trust it or use it for grading. */
  meta?: { commands: number; last_command: string };
}

export interface AppendResult { event_count: number }

/** Body of the 409 response to PUT events. */
export interface ChunkGapError extends ApiError { code: "chunk_gap"; event_count: number }

export interface ChunkInfo { first_event: number; event_count: number; bytes: number; received_at: Ms }

export interface HelpBody { node: string; branch_id: Id; event_count: number; text: string }

export interface HelpRequest {
  id: Id;
  attempt_id: Id;
  assignment_id: Id;
  class_id: Id;
  student: UserRef;
  node: string;
  branch_id: Id;
  event_count: number;
  text: string;
  created_at: Ms;
  resolved_at: Ms | null;
  reply_branch_id: Id | null;
}

export interface ReplyBody { branch_id: Id }

export interface SubmitBody {
  heads: { node: string; branch_id: Id; event_count: number }[];
}

export type VerifyStatus = "queued" | "running" | "ok" | "failed" | "tail_unchecked" | "timeout";

/** The commands of the teacher's check that passed in the latest finished check run. */
export interface SubmissionChecks {
  passed: number;
  total: number;
}

export interface SubmissionSummary {
  id: Id;
  attempt_id: Id;
  created_at: Ms;
  verify_status: VerifyStatus;
  grade: number | null;
  /** The latest finished check run; `null` without one, and for the author of the submission (teachers' data). */
  checks: SubmissionChecks | null;
}

export interface SubmissionJournal { node: string; branch_id: Id; event_count: number; digest: string }

export interface Comment {
  id: Id;
  submission_id: Id;
  node: string;
  event_index: number;
  vtime_ms: number;
  author: UserRef;
  text: string;
  created_at: Ms;
}

export interface CommentBody { node: string; event_index: number; vtime_ms: number; text: string }

export interface TeacherInput { node: string; port: 0 | 2; data: string; author: UserRef; received_at: Ms }

export interface CheckResult { node: string; title: string; command: string; rc: number | null; output: string }

export type CheckRunStatus = "queued" | "running" | "done" | "failed";

export interface CheckRun {
  id: Id;
  submission_id: Id;
  status: CheckRunStatus;
  results: CheckResult[];
  message: string | null;
  created_at: Ms;
  finished_at: Ms | null;
}

/** State of sending a grade to the LMS gradebook (LTI AGS); `pending`: the grade is saved and is being sent. */
export interface LmsGrade {
  status: "pending" | "sent" | "failed";
  error: string | null;
  sent_at: Ms | null;
}

export interface Submission extends SubmissionSummary {
  assignment: { id: Id; title: string; class_id: Id; class_name: string; max_grade: number; due_at: Ms | null };
  student: UserRef;
  journals: SubmissionJournal[];
  verify_message: string | null;
  commands_count: number | null;
  hints_used: { index: number; penalty: number }[];
  /** max_grade minus penalties of opened hints, at least 0. */
  suggested_grade: number;
  note: string;
  graded_by: UserRef | null;
  graded_at: Ms | null;
  comments: Comment[];
  teacher_inputs: TeacherInput[];
  /** How each machine's journal grew: arrival times of chunks along the branch path to the submission. */
  growth: { node: string; chunks: ChunkInfo[] }[];
  check_runs: CheckRun[];
  /** null for the author of the submission and when the student did not come through LTI. */
  lms_grade: LmsGrade | null;
}

export interface GradeBody { grade: number; note?: string }

// Class progress, analytics, activity, notifications, search, calendar

export interface StudentProgress {
  user_id: Id;
  name: string;
  number: number;
  status: TileStatus;
  attempt_id: Id | null;
  started_at: Ms | null;
  last_activity_at: Ms | null;
  commands: number;
  last_command: string;
  rollbacks: number;
  open_help: HelpRequest | null;
  latest_submission: SubmissionSummary | null;
}

export interface Analytics {
  assignment_id: Id;
  students: number;
  opened: number;
  submitted: number;
  /** From opening to the first submission, by server time. */
  minutes_to_submit: { median: number | null; min: number | null; max: number | null };
  per_student: {
    user_id: Id;
    name: string;
    minutes_to_submit: number | null;
    commands: number | null;
    rollbacks: number;
    help_requests: number;
    hints_used: number;
    grade: number | null;
  }[];
  grades: { grade: number; count: number }[];
}

export type ActivityKind =
  | "member_joined"
  | "assignment_created"
  | "attempt_opened"
  | "help_requested"
  | "help_resolved"
  | "help_replied"
  | "submitted"
  | "verify_failed"
  | "graded"
  | "commented"
  | "hint_used";

export interface Activity {
  id: Id;
  class_id: Id;
  assignment_id: Id | null;
  actor: UserRef;
  student: UserRef | null;
  kind: ActivityKind;
  ref_id: Id | null;
  text: string | null;
  at: Ms;
}

export interface NotificationList { items: Activity[]; unread: number }
export interface ReadNotificationsBody { up_to: Id }

/** Review inbox: all classes where I am the owner or an assistant. */
export type ReviewItem =
  | { kind: "submission"; submission: SubmissionSummary; assignment: { id: Id; title: string }; class: { id: Id; name: string }; student: UserRef }
  | { kind: "help"; help: HelpRequest; assignment: { id: Id; title: string }; class: { id: Id; name: string } };

export interface SearchResult {
  classes: { id: Id; name: string }[];
  students: { user_id: Id; name: string; class_id: Id; class_name: string }[];
  assignments: { id: Id; title: string; class_id: Id; class_name: string }[];
  library: { id: Id; kind: ItemKind; title: string }[];
}

export interface CalendarEntry {
  assignment_id: Id;
  title: string;
  class_id: Id;
  class_name: string;
  due_at: Ms;
  my_status: TileStatus | null;
  to_review: number;
}

export interface EmbedInfo { token: string; url: string }
export interface EmbedPayload { title: string; journal: Journal; from_ms: number | null }

export interface ImageManifest {
  /** Prefix the core resolves image paths against (root in profiles.mjs). */
  root: string;
}

// LTI 1.3: any LMS (platform) as the source of students and the gradebook

/** A platform a teacher registered by hand; one row per (issuer, client_id, deployment_id). */
export interface LtiPlatform {
  id: Id;
  name: string;
  issuer: string;
  client_id: string;
  deployment_id: string;
  auth_login_url: string;
  token_url: string;
  jwks_url: string;
  created_at: Ms;
}

export type CreateLtiPlatformBody = Omit<LtiPlatform, "id" | "created_at">;

/** What the teacher copies into the platform's tool settings. */
export interface LtiToolInfo {
  login_url: string;
  launch_url: string;
  jwks_url: string;
}

/** Parameters of the OIDC login initiation that the platform sends. */
export interface LtiLoginParams {
  iss: string;
  login_hint: string;
  target_link_uri?: string;
  lti_message_hint?: string;
  client_id?: string;
  lti_deployment_id?: string;
}

/** The public JWK of the tool, as the platform fetches it. */
export interface LtiJwk {
  kty: string;
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
}

// Route table. Key is "METHOD path"; :params are numeric ids except :code, :token, :node.
// body is the request body, query the query string, res the success response body.
// *.csv and *.ics routes return text, not JSON.

type R<Body, Res, Query = undefined> = { body: Body; res: Res; query: Query };

export interface Api {
  "POST /api/auth/register": R<RegisterBody, Me>;
  "POST /api/auth/login": R<LoginBody, Me>;
  "POST /api/auth/logout": R<undefined, null>;
  "GET /api/me": R<undefined, Me>;
  "PATCH /api/me": R<PatchMeBody, Me>;
  "GET /api/me/assignments": R<undefined, MyAssignment[]>;

  "GET /api/invites/:code": R<undefined, InviteInfo>;
  "POST /api/invites/:code/accept": R<undefined, ClassSummary>;

  "GET /api/classes": R<undefined, ClassSummary[]>;
  "POST /api/classes": R<CreateClassBody, ClassDetail>;
  "GET /api/classes/:id": R<undefined, ClassDetail>;
  "PATCH /api/classes/:id": R<PatchClassBody, ClassDetail>;
  "DELETE /api/classes/:id": R<undefined, null>;
  "POST /api/classes/:id/restore": R<undefined, ClassDetail>;
  "POST /api/classes/:id/invite": R<undefined, ClassDetail>;
  "POST /api/classes/:id/import": R<ImportCsvBody, ImportResult>;
  "POST /api/classes/:id/assistants": R<AddAssistantBody, ClassDetail>;
  "DELETE /api/classes/:id/members/:userId": R<undefined, null>;
  "GET /api/classes/:id/grades.csv": R<undefined, string>;
  "GET /api/classes/:id/activity": R<undefined, Activity[], { before?: Id }>;

  "GET /api/library": R<undefined, LibraryItemSummary[]>;
  "POST /api/library": R<CreateItemBody, LibraryItem>;
  "GET /api/library/:id": R<undefined, LibraryItem>;
  "PATCH /api/library/:id": R<PatchItemBody, LibraryItem>;
  "DELETE /api/library/:id": R<undefined, null>;
  "POST /api/library/:id/restore": R<undefined, LibraryItem>;
  "PUT /api/library/:id/journals/:node": R<Journal, LibraryItem, { role: JournalRole }>;
  "GET /api/library/:id/journals/:node": R<undefined, Journal, { role: JournalRole }>;
  "DELETE /api/library/:id/journals/:node": R<undefined, LibraryItem, { role: JournalRole }>;
  "POST /api/library/:id/assign": R<AssignBody, Assignment>;
  "POST /api/library/:id/embed": R<undefined, EmbedInfo>;
  "DELETE /api/library/:id/embed": R<undefined, null>;
  "POST /api/library/lesson-from-submission": R<LessonFromSubmissionBody, LibraryItem>;
  "POST /api/library/clip": R<ClipBody, LibraryItem>;

  "GET /api/assignments/:id": R<undefined, Assignment>;
  "PATCH /api/assignments/:id": R<PatchAssignmentBody, Assignment>;
  "DELETE /api/assignments/:id": R<undefined, null>;
  "POST /api/assignments/:id/restore": R<undefined, Assignment>;
  "GET /api/assignments/:id/journals/:node": R<undefined, Journal, { role: JournalRole }>;
  "GET /api/assignments/:id/students": R<undefined, StudentProgress[]>;
  "GET /api/assignments/:id/analytics": R<undefined, Analytics>;
  "POST /api/assignments/:id/verify-all": R<undefined, { queued: number }>;
  "POST /api/assignments/:id/check-all": R<undefined, { queued: number }>;
  "GET /api/assignments/:id/attempt": R<undefined, Attempt>;
  "POST /api/assignments/:id/attempt": R<undefined, Attempt>;

  "GET /api/attempts/:id": R<undefined, Attempt>;
  "POST /api/attempts/:id/branches": R<CreateBranchBody, Branch>;
  "POST /api/attempts/:id/heads": R<{ node: string; branch_id: Id }, Attempt>;
  "POST /api/attempts/:id/help": R<HelpBody, HelpRequest>;
  "POST /api/attempts/:id/hints/:index": R<undefined, HintSlot>;
  "POST /api/attempts/:id/submit": R<SubmitBody, SubmissionSummary>;
  "POST /api/attempts/:id/complete": R<undefined, Attempt>;

  "GET /api/branches/:id": R<undefined, BranchDetail>;
  "PUT /api/branches/:id/events": R<AppendEventsBody, AppendResult>;
  "GET /api/branches/:id/journal": R<undefined, Journal, { to?: number }>;
  "GET /api/branches/:id/chunks": R<undefined, ChunkInfo[]>;

  "GET /api/help": R<undefined, HelpRequest[], { open?: "1" }>;
  "POST /api/help/:id/resolve": R<undefined, HelpRequest>;
  "POST /api/help/:id/reply": R<ReplyBody, HelpRequest>;

  "GET /api/review": R<undefined, ReviewItem[]>;
  "GET /api/submissions/:id": R<undefined, Submission>;
  "GET /api/submissions/:id/journals/:node": R<undefined, Journal>;
  "POST /api/submissions/:id/verify": R<undefined, SubmissionSummary>;
  "POST /api/submissions/:id/check-runs": R<undefined, CheckRun>;
  "PUT /api/submissions/:id/grade": R<GradeBody, Submission>;
  "POST /api/submissions/:id/comments": R<CommentBody, Comment>;
  "DELETE /api/comments/:id": R<undefined, null>;

  "GET /api/notifications": R<undefined, NotificationList>;
  "POST /api/notifications/read": R<ReadNotificationsBody, null>;
  "GET /api/search": R<undefined, SearchResult, { q: string }>;
  "GET /api/calendar": R<undefined, CalendarEntry[], { from: Ms; to: Ms }>;
  "GET /api/calendar.ics": R<undefined, string>;

  "GET /api/embed/:token": R<undefined, EmbedPayload>;
  "GET /api/images": R<undefined, ImageManifest>;

  "GET /api/lti/tool": R<undefined, LtiToolInfo>;
  "GET /api/lti/platforms": R<undefined, LtiPlatform[]>;
  "POST /api/lti/platforms": R<CreateLtiPlatformBody, LtiPlatform>;
  "DELETE /api/lti/platforms/:id": R<undefined, null>;
  "GET /api/lti/jwks": R<undefined, { keys: LtiJwk[] }>;
  /** OIDC login initiation: 302 to the platform. A platform sends it as GET or as a form POST. */
  "GET /api/lti/login": R<undefined, null, LtiLoginParams>;
  "POST /api/lti/login": R<LtiLoginParams, null>;
  /** Form post of the platform: 303 to the assignment (an HTML page on a refusal). */
  "POST /api/lti/launch": R<{ id_token: string; state: string }, null>;
}

export type ApiRoute = keyof Api;

/** Runtime list of routes: a server e2e test compares it with the registered routes. */
export const API_ROUTES = [
  "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/logout", "GET /api/me", "PATCH /api/me",
  "GET /api/me/assignments",
  "GET /api/invites/:code", "POST /api/invites/:code/accept",
  "GET /api/classes", "POST /api/classes", "GET /api/classes/:id", "PATCH /api/classes/:id",
  "DELETE /api/classes/:id", "POST /api/classes/:id/restore", "POST /api/classes/:id/invite",
  "POST /api/classes/:id/import", "POST /api/classes/:id/assistants", "DELETE /api/classes/:id/members/:userId",
  "GET /api/classes/:id/grades.csv", "GET /api/classes/:id/activity",
  "GET /api/library", "POST /api/library", "GET /api/library/:id", "PATCH /api/library/:id",
  "DELETE /api/library/:id", "POST /api/library/:id/restore", "PUT /api/library/:id/journals/:node",
  "GET /api/library/:id/journals/:node", "DELETE /api/library/:id/journals/:node", "POST /api/library/:id/assign",
  "POST /api/library/:id/embed", "DELETE /api/library/:id/embed", "POST /api/library/lesson-from-submission",
  "POST /api/library/clip",
  "GET /api/assignments/:id", "PATCH /api/assignments/:id", "DELETE /api/assignments/:id",
  "POST /api/assignments/:id/restore", "GET /api/assignments/:id/journals/:node", "GET /api/assignments/:id/students",
  "GET /api/assignments/:id/analytics", "POST /api/assignments/:id/verify-all", "POST /api/assignments/:id/check-all",
  "GET /api/assignments/:id/attempt", "POST /api/assignments/:id/attempt",
  "GET /api/attempts/:id", "POST /api/attempts/:id/branches", "POST /api/attempts/:id/heads",
  "POST /api/attempts/:id/help", "POST /api/attempts/:id/hints/:index", "POST /api/attempts/:id/submit",
  "POST /api/attempts/:id/complete",
  "GET /api/branches/:id", "PUT /api/branches/:id/events", "GET /api/branches/:id/journal", "GET /api/branches/:id/chunks",
  "GET /api/help", "POST /api/help/:id/resolve", "POST /api/help/:id/reply",
  "GET /api/review", "GET /api/submissions/:id", "GET /api/submissions/:id/journals/:node",
  "POST /api/submissions/:id/verify", "POST /api/submissions/:id/check-runs", "PUT /api/submissions/:id/grade",
  "POST /api/submissions/:id/comments", "DELETE /api/comments/:id",
  "GET /api/notifications", "POST /api/notifications/read", "GET /api/search", "GET /api/calendar",
  "GET /api/calendar.ics",
  "GET /api/embed/:token", "GET /api/images",
  "GET /api/lti/tool", "GET /api/lti/platforms", "POST /api/lti/platforms", "DELETE /api/lti/platforms/:id",
  "GET /api/lti/jwks", "GET /api/lti/login", "POST /api/lti/login", "POST /api/lti/launch",
] as const satisfies readonly ApiRoute[];

// Completeness check: a route present in Api but missing from API_ROUTES is a compile error here.
type Missing = Exclude<ApiRoute, (typeof API_ROUTES)[number]>;
const routes_complete: [Missing] extends [never] ? true : Missing = true;
void routes_complete;
