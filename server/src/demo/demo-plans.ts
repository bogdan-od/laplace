import {
  C_TASK,
  CONFIG_TASK,
  FIREWALL_TASK,
  LESSON,
  LINK_TASK,
  NET_TASK,
  OSPF_TASK,
  RIGHTS_TASK,
  SSH_TASK,
  SUBNET_TASK,
  VLAN_TASK,
  type DemoTask,
} from './demo-data';

/**
 * What the student of the plan's position did:
 * graded - submitted and the teacher graded it; waiting - submitted, not graded;
 * help - stopped halfway and asked for help; answered - the same, and the teacher replied with a branch;
 * progress - stopped halfway without asking; none - did not start.
 */
export type Outcome =
  'graded' | 'waiting' | 'help' | 'answered' | 'progress' | 'none';

/** A teacher's comment at the moment before step `step` of the recording (a negative step counts from the end). */
export interface PlanComment {
  node: string;
  step: number;
  text: string;
}

export interface Plan {
  outcome: Outcome;
  /** Which recording the student replays: `<scenario>-good` or `<scenario>-bad`. */
  good: boolean;
  grade?: number;
  note?: string;
  comments?: PlanComment[];
  /** Index of the hint the student opens before submitting (a penalty). */
  hint?: number;
  /** The student worked on `node` up to the moment before step `abandonAt`, rolled back to the moment before step `forkAt` and did the rest again. */
  rollback?: { node: string; abandonAt: number; forkAt: number };
}

const NONE: Plan = { outcome: 'none', good: true };
const none = (count: number): Plan[] =>
  Array.from({ length: count }, () => NONE);

/** One assignment of a class: the task, the recording scenario its plan replays and the deadline in days from now. */
export interface AssignmentRun {
  key: string;
  task: DemoTask;
  dueDays: number;
  scenario?: string;
  plan?: Plan[];
}

const CONFIG_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 9,
    note: 'Усе виконано акуратно.',
    comments: [
      { node: 'm1', step: -2, text: 'Тут звіт записано правильною командою.' },
    ],
  },
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Відмінно, без зайвих команд.',
  },
  {
    outcome: 'graded',
    good: false,
    grade: 4,
    note: "Ім'я хоста не змінено і звіт має не той вміст: перегляньте завдання ще раз.",
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'waiting', good: false },
  { outcome: 'help', good: false },
  { outcome: 'progress', good: true },
  ...none(1),
  { outcome: 'answered', good: true },
  ...none(3),
];

const LINK_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Мережу налаштовано правильно.',
    comments: [
      { node: 'm1', step: -2, text: 'Добре видно, що пінг іде в обидва боки.' },
    ],
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  { outcome: 'help', good: false },
  ...none(9),
];

const NET_PLAN: Plan[] = [{ outcome: 'waiting', good: true }];

const VLAN_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 8,
    hint: 0,
    note: 'Усе працює. Підказку відкрито: з оцінки знято 1 бал.',
    comments: [
      {
        node: 'r1',
        step: 6,
        text: 'Без пересилання пакетів маршрутизатор нічого не передасть між мережами.',
      },
      {
        node: 'm1',
        step: 8,
        text: 'Маршрут за замовчуванням ведіть через адресу маршрутизатора в своїй мережі.',
      },
    ],
  },
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Чисте виконання.',
  },
  { outcome: 'waiting', good: true },
  {
    outcome: 'waiting',
    good: true,
    rollback: { node: 'r1', abandonAt: 5, forkAt: 2 },
  },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  ...none(8),
];

const FIREWALL_PLAN: Plan[] = [
  { outcome: 'waiting', good: true },
  {
    outcome: 'graded',
    good: true,
    grade: 9,
    note: 'Правило влучне: закрито лише ICMP.',
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'help', good: false },
  { outcome: 'progress', good: true },
  ...none(8),
];

const OSPF_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Сусідство піднялося, маршрут до петлі є.',
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  ...none(9),
];

const SSH_PLAN: Plan[] = [
  { outcome: 'waiting', good: true },
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Усе зроблено правильно.',
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  ...none(9),
];

const C_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 10,
    note: 'Програма рахує правильно.',
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  ...none(5),
];

const RIGHTS_PLAN: Plan[] = [
  {
    outcome: 'graded',
    good: true,
    grade: 9,
    note: 'Права виставлено правильно.',
  },
  { outcome: 'waiting', good: true },
  { outcome: 'waiting', good: false },
  { outcome: 'progress', good: true },
  ...none(6),
];

/** Assignments of the class КН-31 in the order they are created. */
export const KN_RUNS: AssignmentRun[] = [
  {
    key: 'config',
    task: CONFIG_TASK,
    dueDays: -1,
    scenario: 'config',
    plan: CONFIG_PLAN,
  },
  {
    key: 'link',
    task: LINK_TASK,
    dueDays: 3,
    scenario: 'link',
    plan: LINK_PLAN,
  },
  { key: 'lesson', task: LESSON, dueDays: 10 },
  { key: 'net', task: NET_TASK, dueDays: 7, scenario: 'net', plan: NET_PLAN },
  {
    key: 'vlan',
    task: VLAN_TASK,
    dueDays: 5,
    scenario: 'vlan',
    plan: VLAN_PLAN,
  },
  {
    key: 'fw',
    task: FIREWALL_TASK,
    dueDays: 6,
    scenario: 'fw',
    plan: FIREWALL_PLAN,
  },
  {
    key: 'ospf',
    task: OSPF_TASK,
    dueDays: 2,
    scenario: 'ospf',
    plan: OSPF_PLAN,
  },
  { key: 'ssh', task: SSH_TASK, dueDays: 4, scenario: 'ssh', plan: SSH_PLAN },
  { key: 'subnet', task: SUBNET_TASK, dueDays: 7 },
];

/** Assignments of the class ОС-21. */
export const OS_RUNS: AssignmentRun[] = [
  { key: 'csum', task: C_TASK, dueDays: 6, scenario: 'csum', plan: C_PLAN },
  {
    key: 'rights',
    task: RIGHTS_TASK,
    dueDays: 3,
    scenario: 'rights',
    plan: RIGHTS_PLAN,
  },
];
