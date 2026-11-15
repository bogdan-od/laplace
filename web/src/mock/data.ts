export type Status = "stuck" | "work" | "done" | "idle";

export const STATUS_ORDER: Status[] = ["stuck", "work", "done", "idle"];

export const STATUS_LABEL: Record<Status, string> = {
  stuck: "Потрібна допомога",
  work: "Працює",
  done: "Здано",
  idle: "Не почали",
};

export const STATUS_LABEL_MANY: Record<Status, string> = {
  stuck: "просять допомоги",
  work: "працюють",
  done: "здали",
  idle: "не почали",
};

export interface HelpRequest {
  text: string;
  moment: string;
  ago: string;
}

export type MarkKind = "cmd" | "rollback" | "help" | "submit";

export interface Student {
  id: string;
  name: string;
  status: Status;
  started: string | null;
  minutes: number;
  commands: number;
  rollbacks: number;
  machine: string;
  lastCommand: string;
  terminal: string[];
  history?: string[];
  help?: HelpRequest;
  submittedAt?: string;
  grade?: number;
  marks: { at: number; kind: MarkKind }[];
}

export const CLASS_INFO = {
  name: "КН-21",
  subject: "Комп'ютерні мережі",
  teacher: "Ірина Мельник",
  invite: "KN21-7Q4M",
  students: 16,
};

export const ASSIGNMENT = {
  title: "Лаб. 5. Router-on-a-stick: знайдіть несправність",
  brief: "pc2 у VLAN 20 не бачить сервер srv. Знайдіть і виправте помилку, не перезавантажуючи машини.",
  due: "12 листопада, 18:00",
  liveSince: "14:05",
  liveMinutes: 47,
  maxGrade: 10,
  nodes: ["r1", "sw1", "pc1", "pc2", "srv"],
};

export const OTHER_ASSIGNMENTS = [
  { title: "Лаб. 4. Статичні маршрути", done: 16, total: 16, avg: 8.4, due: "5 листопада" },
  { title: "Лаб. 3. Адресація і підмережі", done: 15, total: 16, avg: 7.9, due: "29 жовтня" },
  { title: "Лаб. 6. NAT і iptables", done: 0, total: 16, avg: null, due: "19 листопада" },
];

const marks = (spec: string): Student["marks"] =>
  spec.split(" ").map((s) => {
    const kind = (
      { c: "cmd", r: "rollback", h: "help", s: "submit" } as const
    )[s[0] as "c" | "r" | "h" | "s"];
    return { at: Number(s.slice(1)), kind };
  });

export const STUDENTS: Student[] = [
  {
    id: "s01",
    name: "Ткачук Мирослава",
    status: "stuck",
    started: "14:07",
    minutes: 45,
    commands: 31,
    rollbacks: 2,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.20.10",
    terminal: [
      "pc2:~# ip addr show eth0 | grep inet",
      "    inet 192.168.20.21/24 scope global eth0",
      "pc2:~# ping -c 3 192.168.20.10",
      "3 packets transmitted, 0 received, 100% packet loss",
    ],
    history: [
      "pc2:~# ip route",
      "default via 192.168.20.1 dev eth0",
      "192.168.20.0/24 dev eth0 scope link  src 192.168.20.21",
      "pc2:~# ping -c 2 192.168.20.1",
      "PING 192.168.20.1 (192.168.20.1): 56 data bytes",
      "",
      "--- 192.168.20.1 ping statistics ---",
      "2 packets transmitted, 0 packets received, 100% packet loss",
      "pc2:~# arp -n",
      "? (192.168.20.1) at <incomplete>  on eth0",
      "pc2:~# ip addr show eth0 | grep inet",
      "    inet 192.168.20.21/24 scope global eth0",
      "pc2:~# ping -c 3 192.168.20.10",
      "PING 192.168.20.10 (192.168.20.10): 56 data bytes",
      "",
      "--- 192.168.20.10 ping statistics ---",
      "3 packets transmitted, 0 packets received, 100% packet loss",
      "pc2:~# ",
    ],
    help: {
      text: "pc2 не бачить srv, хоча адреса правильна і маршрут через r1 є",
      moment: "14:47",
      ago: "5 хв тому",
    },
    marks: marks("c3 c5 c8 c11 c12 r14 c15 c19 c22 r25 c27 c31 c34 c36 c38 h40"),
  },
  {
    id: "s02",
    name: "Савчук Остап",
    status: "stuck",
    started: "14:09",
    minutes: 43,
    commands: 18,
    rollbacks: 0,
    machine: "r1",
    lastCommand: "cat /proc/net/vlan/config",
    terminal: [
      "r1:~# cat /proc/net/vlan/config",
      "VLAN Dev name    | VLAN ID",
      "eth0.10        | 10  | eth0",
      "eth0.30        | 30  | eth0",
    ],
    help: {
      text: "Не розумію, звідки взявся eth0.30, у схемі такого VLAN немає",
      moment: "14:42",
      ago: "10 хв тому",
    },
    marks: marks("c4 c9 c13 c18 c24 c29 h33"),
  },
  {
    id: "s03",
    name: "Бондаренко Ярина",
    status: "work",
    started: "14:06",
    minutes: 46,
    commands: 24,
    rollbacks: 1,
    machine: "r1",
    lastCommand: "ip -d link show eth0.30",
    terminal: [
      "r1:~# ip -d link show eth0.30",
      "5: eth0.30@eth0: <BROADCAST,MULTICAST,UP> mtu 1500",
      "    vlan protocol 802.1Q id 30 <REORDER_HDR>",
      "r1:~# ",
    ],
    marks: marks("c2 c6 c9 c12 r16 c18 c23 c29 c33 c37 c41"),
  },
  {
    id: "s04",
    name: "Кравець Данило",
    status: "work",
    started: "14:08",
    minutes: 44,
    commands: 37,
    rollbacks: 3,
    machine: "pc2",
    lastCommand: "tcpdump -ni eth0 -e icmp",
    terminal: [
      "pc2:~# tcpdump -ni eth0 -e icmp",
      "listening on eth0, link-type EN10MB (Ethernet)",
      "14:51:02 02:5e:a1:07:3c:11 > ff:ff:ff:ff:ff:ff, ARP",
      "14:51:03 02:5e:a1:07:3c:11 > ff:ff:ff:ff:ff:ff, ARP",
    ],
    marks: marks("c1 c3 c6 r8 c9 c12 r15 c17 c20 c24 r27 c29 c33 c36 c40 c43"),
  },
  {
    id: "s05",
    name: "Олійник Тарас",
    status: "work",
    started: "14:12",
    minutes: 40,
    commands: 15,
    rollbacks: 0,
    machine: "srv",
    lastCommand: "ip route",
    terminal: [
      "srv:~# ip route",
      "default via 192.168.10.1 dev eth0",
      "192.168.10.0/24 dev eth0 scope link",
      "srv:~# ",
    ],
    marks: marks("c5 c11 c19 c26 c33 c38"),
  },
  {
    id: "s06",
    name: "Лисенко Софія",
    status: "work",
    started: "14:06",
    minutes: 46,
    commands: 29,
    rollbacks: 1,
    machine: "r1",
    lastCommand: "ip link add link eth0 name eth0.20 type vlan id 20",
    terminal: [
      "r1:~# ip link del eth0.30",
      "r1:~# ip link add link eth0 name eth0.20 type vlan id 20",
      "r1:~# ip addr add 192.168.20.1/24 dev eth0.20",
      "r1:~# ",
    ],
    marks: marks("c2 c4 c8 c13 c17 r20 c22 c28 c34 c39 c44 c45"),
  },
  {
    id: "s07",
    name: "Гнатюк Максим",
    status: "work",
    started: "14:15",
    minutes: 37,
    commands: 12,
    rollbacks: 0,
    machine: "pc1",
    lastCommand: "ping -c 2 192.168.10.1",
    terminal: [
      "pc1:~# ping -c 2 192.168.10.1",
      "64 bytes from 192.168.10.1: seq=0 ttl=64 time=1.912 ms",
      "64 bytes from 192.168.10.1: seq=1 ttl=64 time=1.204 ms",
      "pc1:~# ",
    ],
    marks: marks("c8 c14 c21 c30 c35"),
  },
  {
    id: "s08",
    name: "Павленко Ілля",
    status: "work",
    started: "14:10",
    minutes: 42,
    commands: 21,
    rollbacks: 0,
    machine: "r1",
    lastCommand: "ip addr show",
    terminal: [
      "r1:~# ip addr show eth0.10",
      "4: eth0.10@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>",
      "    inet 192.168.10.1/24 scope global eth0.10",
      "r1:~# ",
    ],
    marks: marks("c3 c7 c12 c16 c21 c27 c31 c38"),
  },
  {
    id: "s09",
    name: "Шевчук Анастасія",
    status: "done",
    started: "14:06",
    minutes: 28,
    commands: 19,
    rollbacks: 0,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.10.10",
    terminal: [
      "pc2:~# ping -c 3 192.168.10.10",
      "64 bytes from 192.168.10.10: seq=0 ttl=63 time=2.871 ms",
      "3 packets transmitted, 3 received, 0% packet loss",
      "pc2:~# ",
    ],
    submittedAt: "14:34",
    grade: 10,
    marks: marks("c2 c5 c9 c13 c17 c21 c25 s28"),
  },
  {
    id: "s10",
    name: "Руденко Вероніка",
    status: "done",
    started: "14:07",
    minutes: 33,
    commands: 26,
    rollbacks: 1,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.10.10",
    terminal: [
      "pc2:~# ping -c 3 192.168.10.10",
      "3 packets transmitted, 3 received, 0% packet loss",
      "pc2:~# ",
      "",
    ],
    submittedAt: "14:40",
    grade: 9,
    marks: marks("c3 c6 c10 r12 c14 c19 c24 c29 s33"),
  },
  {
    id: "s11",
    name: "Захарченко Марко",
    status: "done",
    started: "14:06",
    minutes: 22,
    commands: 14,
    rollbacks: 0,
    machine: "r1",
    lastCommand: "ip link set eth0.20 up",
    terminal: [
      "r1:~# ip link set eth0.20 up",
      "r1:~# ",
      "",
      "",
    ],
    submittedAt: "14:28",
    marks: marks("c2 c6 c11 c15 c19 s22"),
  },
  {
    id: "s12",
    name: "Іваненко Дарина",
    status: "done",
    started: "14:08",
    minutes: 39,
    commands: 33,
    rollbacks: 2,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.10.10",
    terminal: [
      "pc2:~# ping -c 3 192.168.10.10",
      "3 packets transmitted, 3 received, 0% packet loss",
      "pc2:~# ",
      "",
    ],
    submittedAt: "14:47",
    marks: marks("c1 c4 c7 r10 c12 c16 c20 r24 c27 c31 c35 s39"),
  },
  {
    id: "s13",
    name: "Коваль Назар",
    status: "done",
    started: "14:11",
    minutes: 30,
    commands: 17,
    rollbacks: 0,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.10.10",
    terminal: ["pc2:~# ping -c 3 192.168.10.10", "3 packets transmitted, 3 received, 0% packet loss", "pc2:~# ", ""],
    submittedAt: "14:41",
    grade: 8,
    marks: marks("c4 c9 c14 c19 c24 c27 s30"),
  },
  {
    id: "s14",
    name: "Поліщук Олександра",
    status: "done",
    started: "14:07",
    minutes: 36,
    commands: 22,
    rollbacks: 1,
    machine: "pc2",
    lastCommand: "ping -c 3 192.168.10.10",
    terminal: ["pc2:~# ping -c 3 192.168.10.10", "3 packets transmitted, 3 received, 0% packet loss", "pc2:~# ", ""],
    submittedAt: "14:43",
    marks: marks("c3 c8 c12 r15 c18 c23 c28 c32 s36"),
  },
  {
    id: "s15",
    name: "Тимошенко Артем",
    status: "idle",
    started: null,
    minutes: 0,
    commands: 0,
    rollbacks: 0,
    machine: "-",
    lastCommand: "",
    terminal: ["", "", "", ""],
    marks: [],
  },
  {
    id: "s16",
    name: "Яковенко Злата",
    status: "idle",
    started: null,
    minutes: 0,
    commands: 0,
    rollbacks: 0,
    machine: "-",
    lastCommand: "",
    terminal: ["", "", "", ""],
    marks: [],
  },
];

export function countByStatus(): Record<Status, number> {
  const counts: Record<Status, number> = { stuck: 0, work: 0, done: 0, idle: 0 };
  for (const s of STUDENTS) counts[s.status] += 1;
  return counts;
}

export function sortedStudents(): Student[] {
  return [...STUDENTS].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
}
