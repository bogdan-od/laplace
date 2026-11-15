import { join } from 'node:path';
import type { CheckCommand, Hint, Topology } from '@shared/api';

/** Recorded journals of the demo, relative to the repository root. */
export const DEMO_JOURNALS_DIR = join('server', 'demo', 'journals');
export const MARKS_FILE = 'marks.json';

export const TEACHER = {
  login: 'teacher',
  password: 'teacher-demo',
  name: 'Тетяна Миколаївна Гнатюк',
};
export const ASSISTANT = {
  login: 'assistant',
  password: 'assistant-demo',
  name: 'Руденко Остап',
};
export const STUDENT_PASSWORD = 'student-demo';
export const CLASS_NAME = 'КН-31';
export const CLASS_SUBJECT = "Комп'ютерні мережі";
export const OS_CLASS_NAME = 'ОС-21';
export const OS_CLASS_SUBJECT = 'Операційні системи';

export const STUDENT_NAMES = [
  'Коваленко Олександр',
  'Шевченко Марія',
  'Бондаренко Андрій',
  'Ткаченко Софія',
  'Мельник Дмитро',
  'Кравченко Анастасія',
  'Олійник Максим',
  'Шевчук Вероніка',
  'Поліщук Назар',
  'Лисенко Катерина',
  'Мороз Ігор',
  'Петренко Юлія',
  'Гриценко Артем',
  'Савченко Дарина',
] as const;

/** Students of the second class; their logins continue the numbering of `STUDENT_NAMES`. */
export const OS_STUDENT_NAMES = [
  'Іваненко Тарас',
  'Романюк Оксана',
  'Давиденко Богдан',
  'Мартинюк Інна',
  'Остапенко Роман',
  'Яковенко Світлана',
  'Клименко Денис',
  'Захарченко Ольга',
  'Прокопенко Віталій',
  'Данильчук Павло',
] as const;

export const studentLogin = (index: number): string =>
  `student${String(index + 1).padStart(2, '0')}`;

export interface DemoTask {
  title: string;
  brief: string;
  kind: 'task' | 'lesson';
  topology: Topology;
  checks: CheckCommand[];
  hints: Hint[];
}

const CONFIG_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: [{ id: 'm1', title: 'Робоча станція', profile: 'buildroot' }],
  switches: [],
  links: [],
};

const LINK_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: [
    {
      id: 'm1',
      title: "Комп'ютер 1",
      profile: 'buildroot',
      setup: 'ifconfig eth0 hw ether {mac} up\n',
    },
    {
      id: 'm2',
      title: "Комп'ютер 2",
      profile: 'buildroot',
      setup: 'ifconfig eth0 hw ether {mac} up\n',
    },
  ],
  switches: [{ id: 'sw1' }],
  links: [
    { machine: 'm1', switch: 'sw1', mode: 'access', vlan: 1 },
    { machine: 'm2', switch: 'sw1', mode: 'access', vlan: 1 },
  ],
};

const NET_SIZE = 6;
const netId = (n: number): string => `m${n}`;

/** Six computers of the `net` image on one switch, 10.0.0.1 ... 10.0.0.6. */
const NET_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: Array.from({ length: NET_SIZE }, (_, index) => ({
    id: netId(index + 1),
    title: `Комп'ютер ${index + 1}`,
    profile: 'net' as const,
    setup: 'ifconfig eth0 hw ether {mac} up\n',
  })),
  switches: [{ id: 'sw1' }],
  links: Array.from({ length: NET_SIZE }, (_, index) => ({
    machine: netId(index + 1),
    switch: 'sw1',
    mode: 'access' as const,
    vlan: 1,
  })),
};

export const CONFIG_TASK: DemoTask = {
  kind: 'task',
  title: 'Налаштування робочої станції',
  brief:
    "Налаштуйте лабораторну машину:\n1. Задайте ім'я хоста lab-pc командою hostname.\n2. Створіть каталог /tmp/lab.\n3. Запишіть версію ядра (результат uname -r) у файл /tmp/lab/report.txt.",
  topology: CONFIG_TOPOLOGY,
  checks: [
    {
      node: 'm1',
      title: "Ім'я хоста lab-pc",
      command: 'test "$(hostname)" = lab-pc',
    },
    { node: 'm1', title: 'Каталог /tmp/lab', command: 'test -d /tmp/lab' },
    {
      node: 'm1',
      title: 'Звіт з версією ядра',
      command: 'grep -qx "$(uname -r)" /tmp/lab/report.txt',
    },
  ],
  hints: [
    { text: "Ім'я хоста змінює команда hostname з новим іменем.", penalty: 1 },
    {
      text: 'Вивід команди можна записати у файл символом > (наприклад, uname -r > файл).',
      penalty: 2,
    },
  ],
};

export const LINK_TASK: DemoTask = {
  kind: 'task',
  title: "Зв'язок двох комп'ютерів через комутатор",
  brief:
    "Два комп'ютери з'єднані комутатором, але адрес у них немає. Задайте першому адресу 10.0.0.1, другому 10.0.0.2 (маска 255.255.255.0) командою ifconfig і переконайтеся командою ping, що вони бачать один одного.",
  topology: LINK_TOPOLOGY,
  checks: [
    { node: 'm1', title: 'Пінг 1 → 2', command: 'ping -c 2 -W 2 10.0.0.2' },
    { node: 'm2', title: 'Пінг 2 → 1', command: 'ping -c 2 -W 2 10.0.0.1' },
  ],
  hints: [
    {
      text: 'Адресу й маску задає ifconfig eth0 <адреса> netmask <маска> up.',
      penalty: 1,
    },
  ],
};

export const NET_TASK: DemoTask = {
  kind: 'task',
  title: "Мережа з шести комп'ютерів",
  brief:
    "Шість комп'ютерів з'єднані одним комутатором, адрес у них немає. Задайте комп'ютерам адреси від 10.0.0.1 до 10.0.0.6 (маска 255.255.255.0) командою ifconfig і переконайтеся командою ping, що перший комп'ютер бачить шостий і навпаки.",
  topology: NET_TOPOLOGY,
  checks: [
    { node: 'm1', title: 'Пінг 1 → 6', command: 'ping -c 2 -W 2 10.0.0.6' },
    { node: 'm6', title: 'Пінг 6 → 1', command: 'ping -c 2 -W 2 10.0.0.1' },
  ],
  hints: [
    {
      text: "На кожному комп'ютері адресу задає ifconfig eth0 <адреса> netmask <маска> up, у кожного адреса своя.",
      penalty: 1,
    },
  ],
};

const NET_SETUP = 'ifconfig eth0 hw ether {mac} up\n';
const netMachine = (
  id: string,
  title: string,
  setup: string = NET_SETUP,
): Topology['machines'][number] => ({ id, title, profile: 'net', setup });
const access = (machine: string, vlan: number): Topology['links'][number] => ({
  machine,
  switch: 'sw1',
  mode: 'access',
  vlan,
});

/** `m1` in VLAN 10, `m2` in VLAN 20 and the router `r1` on a trunk of one switch. */
const VLAN_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: [
    netMachine('m1', "Комп'ютер 1"),
    netMachine('m2', "Комп'ютер 2"),
    netMachine('r1', 'Маршрутизатор'),
  ],
  switches: [{ id: 'sw1' }],
  links: [
    access('m1', 10),
    access('m2', 20),
    { machine: 'r1', switch: 'sw1', mode: 'trunk', allowed: [10, 20] },
  ],
};

/** Web server `m1` and client `m2` in one VLAN. */
const PAIR_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: [netMachine('m1', 'Сервер'), netMachine('m2', 'Клієнт')],
  switches: [{ id: 'sw1' }],
  links: [access('m1', 1), access('m2', 1)],
};

const vlanSubinterface = (vlan: number, address: string): string =>
  `ip link add link eth0 name eth0.${vlan} type vlan id ${vlan}; ip addr add ${address} dev eth0.${vlan}; ip link set eth0.${vlan} up`;

/** Three routers in a line: r1 - VLAN 12 - r2 - VLAN 23 - r3, with a loopback address on r1 and r3. */
const OSPF_TOPOLOGY: Topology = {
  format: 'v86-topology/1',
  machines: [
    netMachine(
      'r1',
      'Роутер 1',
      `ifconfig eth0 hw ether {mac} 10.0.12.1 netmask 255.255.255.0 up; ip addr add 10.255.0.1/32 dev lo\n`,
    ),
    netMachine(
      'r2',
      'Роутер 2',
      `ifconfig eth0 hw ether {mac} up; ${vlanSubinterface(12, '10.0.12.2/24')}; ${vlanSubinterface(23, '10.0.23.2/24')}; echo 1 > /proc/sys/net/ipv4/ip_forward\n`,
    ),
    netMachine(
      'r3',
      'Роутер 3',
      `ifconfig eth0 hw ether {mac} 10.0.23.3 netmask 255.255.255.0 up; ip addr add 10.255.0.3/32 dev lo\n`,
    ),
  ],
  switches: [{ id: 'sw1' }],
  links: [
    access('r1', 12),
    { machine: 'r2', switch: 'sw1', mode: 'trunk', allowed: [12, 23] },
    access('r3', 23),
  ],
};

const singleMachine = (
  profile: 'buildroot' | 'study',
  title: string,
): Topology => ({
  format: 'v86-topology/1',
  machines: [{ id: 'm1', title, profile }],
  switches: [],
  links: [],
});

export const VLAN_TASK: DemoTask = {
  kind: 'task',
  title: 'VLAN і маршрутизатор на одній карті',
  brief:
    "Комп'ютер 1 стоїть у VLAN 10, комп'ютер 2 - у VLAN 20, а маршрутизатор r1 з'єднаний із комутатором одним транком.\n1. На r1 створіть підінтерфейси eth0.10 (192.168.10.1/24) і eth0.20 (192.168.20.1/24) та ввімкніть ip_forward.\n2. На m1 задайте 192.168.10.2 і маршрут за замовчуванням через 192.168.10.1, на m2 - 192.168.20.2 і маршрут через 192.168.20.1.\n3. Переконайтеся, що m1 і m2 бачать один одного.",
  topology: VLAN_TOPOLOGY,
  checks: [
    {
      node: 'm1',
      title: 'Пінг m1 → m2',
      command: 'ping -c 2 -W 2 192.168.20.2',
    },
    {
      node: 'm2',
      title: 'Пінг m2 → m1',
      command: 'ping -c 2 -W 2 192.168.10.2',
    },
  ],
  hints: [
    {
      text: 'Підінтерфейс створює команда ip link add link eth0 name eth0.10 type vlan id 10; адресу задає ip addr add, а вмикає ip link set eth0.10 up.',
      penalty: 1,
    },
  ],
};

export const FIREWALL_TASK: DemoTask = {
  kind: 'task',
  title: 'Брандмауер: закрити ping, залишити HTTP',
  brief:
    "Комп'ютер 1 - веб-сервер, комп'ютер 2 - клієнт (адреси 10.0.0.1 і 10.0.0.2).\n1. На m1 створіть каталог /www зі сторінкою index.html і запустіть сервер командою httpd -h /www.\n2. Правилом iptables на m1 заборонте ping, але не веб-запити.\n3. З m2 перевірте, що сторінка http://10.0.0.1/index.html відкривається (wget -q -O- адреса), а ping не проходить.",
  topology: PAIR_TOPOLOGY,
  checks: [
    {
      node: 'm2',
      title: 'Сторінка відкривається',
      command: 'wget -q -O- http://10.0.0.1/index.html',
    },
    {
      node: 'm2',
      title: 'Ping заборонено',
      command: '! ping -c 1 -W 2 10.0.0.1',
    },
  ],
  hints: [
    {
      text: 'Ping - це ICMP: правило iptables -A INPUT -p icmp -j DROP відкидає лише його.',
      penalty: 2,
    },
  ],
};

export const OSPF_TASK: DemoTask = {
  kind: 'task',
  title: 'Динамічна маршрутизація OSPF',
  brief:
    'Три маршрутизатори стоять у лінію, адреси на інтерфейсах уже задано. Напишіть /etc/bird.conf для кожного і запустіть bird так, щоб r1 бачив петлю 10.255.0.3 на r3.',
  topology: OSPF_TOPOLOGY,
  checks: [
    {
      node: 'r1',
      title: 'Пінг петлі r3',
      command: 'ping -c 2 -W 2 10.255.0.3',
    },
    {
      node: 'r1',
      title: 'Сусід у стані Full',
      command: 'birdcl show ospf neighbors | grep -q Full',
    },
  ],
  hints: [
    {
      text: 'Зразок: router id 10.255.0.1; protocol device {}  protocol kernel { ipv4 { export all; }; }  protocol ospf v2 { ipv4 { import all; export all; }; area 0 { interface "eth0" { type ptp; hello 2; dead 8; retransmit 2; }; interface "lo" { stub; }; }; }',
      penalty: 2,
    },
  ],
};

export const SSH_TASK: DemoTask = {
  kind: 'task',
  title: 'Віддалений доступ по SSH',
  brief:
    "Задайте комп'ютерам адреси 10.0.0.1 і 10.0.0.2. На m1 запустіть сервер dropbear -R -B, а з m2 створіть на m1 файл /tmp/from-m2 командою через ssh. Прапорець -y приймає ключ хоста без питання.",
  topology: PAIR_TOPOLOGY,
  checks: [
    {
      node: 'm1',
      title: 'Файл створено з m2',
      command: 'test -f /tmp/from-m2',
    },
  ],
  hints: [
    {
      text: "Команда клієнта: ssh -y root@10.0.0.1 'touch /tmp/from-m2'.",
      penalty: 1,
    },
  ],
};

/** Nobody starts it: an assignment with a deadline in a week. */
export const SUBNET_TASK: DemoTask = {
  kind: 'task',
  title: 'Підмережі: маска 255.255.255.128',
  brief:
    "Задайте двом комп'ютерам адреси 10.0.0.1 і 10.0.0.2 з маскою 255.255.255.128 і перевірте ping. Потім змініть адресу другого на 10.0.0.129 і поясніть, чому зв'язок зник.",
  topology: LINK_TOPOLOGY,
  checks: [
    {
      node: 'm1',
      title: 'Маска /25 на m1',
      command: 'ifconfig eth0 | grep -q 255.255.255.128',
    },
    { node: 'm1', title: 'Пінг 1 → 2', command: 'ping -c 2 -W 2 10.0.0.2' },
  ],
  hints: [],
};

export const C_TASK: DemoTask = {
  kind: 'task',
  title: 'Програма на C: сума аргументів',
  brief:
    'Напишіть у файлі /root/sum.c програму, яка друкує суму аргументів командного рядка (цілих чисел), і скомпілюйте її gcc. Приклад: ./sum 2 3 4 друкує 9.',
  topology: singleMachine('study', 'Навчальна машина'),
  checks: [
    {
      node: 'm1',
      title: 'Сума 2 + 3 + 4 = 9',
      command: 'gcc -o /tmp/s /root/sum.c && test "$(/tmp/s 2 3 4)" = 9',
    },
  ],
  hints: [
    {
      text: 'Аргументи приходять у main(int argc, char **argv) як рядки; число з рядка дає atoi з stdlib.h.',
      penalty: 1,
    },
  ],
};

export const RIGHTS_TASK: DemoTask = {
  kind: 'task',
  title: 'Права доступу до файлу',
  brief:
    'Створіть файл /root/secret.txt з будь-яким вмістом і зробіть так, щоб його міг читати й змінювати лише власник (права 600, у ls -l це -rw-------).',
  topology: singleMachine('buildroot', 'Робоча станція'),
  checks: [
    {
      node: 'm1',
      title: 'Права 600',
      command: 'ls -l /root/secret.txt | grep -q "^-rw------- "',
    },
  ],
  hints: [{ text: 'Права змінює chmod; 600 - це rw-------.', penalty: 1 }],
};

export const LESSON: DemoTask = {
  kind: 'lesson',
  title: 'Урок: перші команди в терміналі',
  brief:
    'Подивіться, як викладач працює в терміналі, а останній крок повторіть самостійно.',
  topology: CONFIG_TOPOLOGY,
  checks: [],
  hints: [],
};

export interface Step {
  node: string;
  text: string;
  /** Real time to wait after typing, for commands that take long (ping). */
  waitMs?: number;
}

export interface Scenario {
  name: string;
  topology: Topology;
  steps: Step[];
  /** The task's checks: after recording they run on the live machines. */
  checks: CheckCommand[];
  /** Whether all of the checks must pass (a "good" recording) or at least one must fail (a "bad" one). */
  passes: boolean;
}

const PING_WAIT_MS = 7000;
const IPTABLES_WAIT_MS = 3000;
const OSPF_CONVERGE_MS = 40_000;
const SSH_KEY_WAIT_MS = 15_000;
const COMPILE_WAIT_MS = 20_000;

const VLAN_ROUTER_STEPS: Step[] = [
  { node: 'r1', text: 'ip link add link eth0 name eth0.10 type vlan id 10\n' },
  { node: 'r1', text: 'ip link add link eth0 name eth0.20 type vlan id 20\n' },
  { node: 'r1', text: 'ip addr add 192.168.10.1/24 dev eth0.10\n' },
  { node: 'r1', text: 'ip addr add 192.168.20.1/24 dev eth0.20\n' },
  { node: 'r1', text: 'ip link set eth0.10 up\n' },
  { node: 'r1', text: 'ip link set eth0.20 up\n' },
];
const vlanHost = (node: string, subnet: number): Step[] => [
  {
    node,
    text: `ifconfig eth0 192.168.${subnet}.2 netmask 255.255.255.0 up\n`,
  },
  { node, text: `route add default gw 192.168.${subnet}.1\n` },
];
const vlanScenario = (name: string, forward: boolean): Scenario => ({
  name,
  topology: VLAN_TOPOLOGY,
  checks: VLAN_TASK.checks,
  passes: forward,
  steps: [
    ...VLAN_ROUTER_STEPS,
    ...(forward
      ? [{ node: 'r1', text: 'echo 1 > /proc/sys/net/ipv4/ip_forward\n' }]
      : []),
    ...vlanHost('m1', 10),
    ...vlanHost('m2', 20),
    { node: 'm1', text: 'ping -c 2 -W 2 192.168.20.2\n', waitMs: PING_WAIT_MS },
    { node: 'm2', text: 'ping -c 2 -W 2 192.168.10.2\n', waitMs: PING_WAIT_MS },
  ],
});

const PAIR_ADDRESS_STEPS: Step[] = [
  { node: 'm1', text: 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0 up\n' },
  { node: 'm2', text: 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0 up\n' },
];

const firewallScenario = (name: string, rule: string): Scenario => ({
  name,
  topology: PAIR_TOPOLOGY,
  checks: FIREWALL_TASK.checks,
  passes: rule.includes('icmp'),
  steps: [
    ...PAIR_ADDRESS_STEPS,
    { node: 'm1', text: 'mkdir /www\n' },
    { node: 'm1', text: "echo '<h1>Hello from m1</h1>' > /www/index.html\n" },
    { node: 'm1', text: 'httpd -h /www\n' },
    {
      node: 'm1',
      text: `iptables -A INPUT ${rule}\n`,
      waitMs: IPTABLES_WAIT_MS,
    },
    {
      node: 'm2',
      text: 'wget -q -O- http://10.0.0.1/index.html\n',
      waitMs: PING_WAIT_MS,
    },
    { node: 'm2', text: 'ping -c 1 -W 2 10.0.0.1\n', waitMs: PING_WAIT_MS },
  ],
});

/** BIRD config of a router of the OSPF task; `port` is the BIRD name pattern of its interface. */
const birdConfig = (id: string, port: string, loopback: boolean): string =>
  [
    `router id ${id};`,
    'protocol device {}',
    'protocol kernel { ipv4 { export all; }; }',
    'protocol ospf v2 {',
    'ipv4 { import all; export all; };',
    'area 0 {',
    `interface "${port}" { type ptp; hello 2; dead 8; retransmit 2; };`,
    ...(loopback ? ['interface "lo" { stub; };'] : []),
    '};',
    '}',
  ].join('\n');

const writeBird = (node: string, config: string): Step => ({
  node,
  text: `cat > /etc/bird.conf <<'EOF'\n${config}\nEOF\n`,
});

const ospfScenario = (name: string, routers: string[]): Scenario => ({
  name,
  topology: OSPF_TOPOLOGY,
  checks: OSPF_TASK.checks,
  passes: routers.length === 3,
  steps: [
    writeBird('r1', birdConfig('10.255.0.1', 'eth0', true)),
    writeBird('r2', birdConfig('10.255.0.2', 'eth0.*', false)),
    writeBird('r3', birdConfig('10.255.0.3', 'eth0', true)),
    ...routers.map((node) => ({ node, text: 'bird\n' })),
    {
      node: 'r1',
      text: 'birdcl show ospf neighbors\n',
      waitMs: OSPF_CONVERGE_MS,
    },
    { node: 'r1', text: 'ping -c 2 -W 2 10.255.0.3\n', waitMs: PING_WAIT_MS },
  ],
});

const sshScenario = (name: string, server: boolean): Scenario => ({
  name,
  topology: PAIR_TOPOLOGY,
  checks: SSH_TASK.checks,
  passes: server,
  steps: [
    ...PAIR_ADDRESS_STEPS,
    ...(server ? [{ node: 'm1', text: 'dropbear -R -B\n' }] : []),
    {
      node: 'm2',
      text: "ssh -y root@10.0.0.1 'touch /tmp/from-m2'\n",
      waitMs: SSH_KEY_WAIT_MS,
    },
    { node: 'm2', text: 'echo done\n' },
  ],
});

const csumScenario = (name: string, sum: boolean): Scenario => ({
  name,
  topology: C_TASK.topology,
  checks: C_TASK.checks,
  passes: sum,
  steps: [
    {
      node: 'm1',
      text: [
        "cat > sum.c <<'EOF'",
        '#include <stdio.h>',
        '#include <stdlib.h>',
        'int main(int argc, char **argv) {',
        'int s = 0;',
        sum
          ? 'for (int i = 1; i < argc; i++) s += atoi(argv[i]);'
          : 's = argc - 1;',
        'printf("%d\\n", s);',
        'return 0;',
        '}',
        'EOF',
        '',
      ].join('\n'),
    },
    { node: 'm1', text: 'gcc -o sum sum.c\n', waitMs: COMPILE_WAIT_MS },
    { node: 'm1', text: './sum 2 3 4\n' },
  ],
});

const rightsScenario = (name: string, mode: string): Scenario => ({
  name,
  topology: RIGHTS_TASK.topology,
  checks: RIGHTS_TASK.checks,
  passes: mode === '600',
  steps: [
    { node: 'm1', text: 'echo top-secret > /root/secret.txt\n' },
    { node: 'm1', text: `chmod ${mode} /root/secret.txt\n` },
    { node: 'm1', text: 'ls -l /root/secret.txt\n' },
  ],
});

export const SCENARIOS: Scenario[] = [
  {
    name: 'config-good',
    topology: CONFIG_TOPOLOGY,
    checks: CONFIG_TASK.checks,
    passes: true,
    steps: [
      { node: 'm1', text: 'hostname lab-pc\n' },
      { node: 'm1', text: 'mkdir /tmp/lab\n' },
      { node: 'm1', text: 'uname -r > /tmp/lab/report.txt\n' },
      { node: 'm1', text: 'hostname\n' },
      { node: 'm1', text: 'cat /tmp/lab/report.txt\n' },
    ],
  },
  {
    name: 'config-bad',
    topology: CONFIG_TOPOLOGY,
    checks: CONFIG_TASK.checks,
    passes: false,
    steps: [
      { node: 'm1', text: 'hostname\n' },
      { node: 'm1', text: 'mkdir /tmp/lab\n' },
      { node: 'm1', text: 'echo hello > /tmp/lab/report.txt\n' },
      { node: 'm1', text: 'ls /tmp/lab\n' },
    ],
  },
  {
    name: 'link-good',
    topology: LINK_TOPOLOGY,
    checks: LINK_TASK.checks,
    passes: true,
    steps: [
      { node: 'm1', text: 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0 up\n' },
      { node: 'm2', text: 'ifconfig eth0 10.0.0.2 netmask 255.255.255.0 up\n' },
      { node: 'm1', text: 'ping -c 2 -W 2 10.0.0.2\n', waitMs: PING_WAIT_MS },
      { node: 'm2', text: 'ping -c 2 -W 2 10.0.0.1\n', waitMs: PING_WAIT_MS },
    ],
  },
  {
    name: 'link-bad',
    topology: LINK_TOPOLOGY,
    checks: LINK_TASK.checks,
    passes: false,
    steps: [
      { node: 'm1', text: 'ifconfig eth0 10.0.0.1 netmask 255.255.255.0 up\n' },
      { node: 'm2', text: 'ifconfig eth0 10.0.1.2 netmask 255.255.255.0 up\n' },
      { node: 'm1', text: 'ping -c 2 -W 2 10.0.0.2\n', waitMs: PING_WAIT_MS },
    ],
  },
  {
    name: 'net-good',
    topology: NET_TOPOLOGY,
    checks: NET_TASK.checks,
    passes: true,
    steps: [
      ...NET_TOPOLOGY.machines.map((machine, index) => ({
        node: machine.id,
        text: `ifconfig eth0 10.0.0.${index + 1} netmask 255.255.255.0 up\n`,
      })),
      { node: 'm1', text: 'ping -c 2 -W 2 10.0.0.6\n', waitMs: PING_WAIT_MS },
      { node: 'm6', text: 'ping -c 2 -W 2 10.0.0.1\n', waitMs: PING_WAIT_MS },
    ],
  },
  vlanScenario('vlan-good', true),
  vlanScenario('vlan-bad', false),
  firewallScenario('fw-good', '-p icmp -j DROP'),
  firewallScenario('fw-bad', '-p tcp --dport 80 -j REJECT'),
  ospfScenario('ospf-good', ['r1', 'r2', 'r3']),
  ospfScenario('ospf-bad', ['r1', 'r3']),
  sshScenario('ssh-good', true),
  sshScenario('ssh-bad', false),
  csumScenario('csum-good', true),
  csumScenario('csum-bad', false),
  rightsScenario('rights-good', '600'),
  rightsScenario('rights-bad', '644'),
  {
    name: 'lesson',
    topology: CONFIG_TOPOLOGY,
    checks: LESSON.checks,
    passes: true,
    steps: [
      { node: 'm1', text: 'uname -r\n' },
      { node: 'm1', text: 'ls /\n' },
      { node: 'm1', text: 'echo hello-lab > /tmp/hello.txt\n' },
      { node: 'm1', text: 'cat /tmp/hello.txt\n' },
    ],
  },
];

/** Texts of the lesson: a note shows from the event before step `step`, a "yourself" segment covers steps. */
export const LESSON_MARKUP = [
  {
    t: 'note',
    step: 0,
    text: 'Це лабораторна машина. Спершу дізнаємося версію ядра командою uname -r.',
  },
  {
    t: 'note',
    step: 1,
    text: 'Команда ls / показує вміст кореневого каталогу.',
  },
  {
    t: 'self',
    from: 2,
    to: 4,
    text: 'Запишіть рядок у файл /tmp/hello.txt і виведіть його на екран.',
  },
] as const;
