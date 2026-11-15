import type { ActivityKind } from '@shared/api';

/** Who is notified of an activity kind. Other kinds go to the log only. */
export const TEACHER_KINDS: readonly ActivityKind[] = [
  'help_requested',
  'submitted',
  'verify_failed',
];
export const OWNER_ONLY_KINDS: readonly ActivityKind[] = ['member_joined'];
export const STUDENT_KINDS: readonly ActivityKind[] = [
  'graded',
  'commented',
  'help_replied',
  'help_resolved',
];

export const sqlList = (kinds: readonly string[]): string =>
  kinds.map((kind) => `'${kind}'`).join(', ');
