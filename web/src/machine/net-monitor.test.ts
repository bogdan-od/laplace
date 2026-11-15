import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build_topology, type Topology } from "@core/net/topology.mjs";
import { CAPTURED_BYTES, FRAME_LOG_LIMIT, NET_PUBLISH_MS, NetMonitor, linkKey } from "./net-monitor";

class FakeMachine {
  readonly received: Uint8Array[] = [];
  #out: ((frame: Uint8Array) => void)[] = [];
  net_in(frame: Uint8Array): void {
    this.received.push(frame);
  }
  on(_name: "net_out", fn: (frame: Uint8Array) => void): void {
    this.#out.push(fn);
  }
  off(_name: "net_out", fn: (frame: Uint8Array) => void): void {
    this.#out = this.#out.filter((item) => item !== fn);
  }
  send(frame: Uint8Array): void {
    for (const fn of [...this.#out]) fn(frame);
  }
}

const mac = (last: number): number[] => [0x02, 0, 0, 0, 0, last];
const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const frame = (dst: number[], src: number[]): Uint8Array =>
  Uint8Array.from([...dst, ...src, 0x88, 0xb5, ...new Array<number>(50).fill(7)]);

/** pc1 and pc2 on sw1, pc3 on sw2, sw1-sw2 trunk. All in VLAN 10. */
const TWO_SWITCHES: Topology = {
  format: "v86-topology/1",
  machines: [
    { id: "pc1", profile: "net" },
    { id: "pc2", profile: "net" },
    { id: "pc3", profile: "net" },
  ],
  switches: [{ id: "sw1" }, { id: "sw2" }],
  links: [
    { machine: "pc1", switch: "sw1", mode: "access", vlan: 10 },
    { machine: "pc2", switch: "sw1", mode: "access", vlan: 10 },
    { machine: "pc3", switch: "sw2", mode: "access", vlan: 10 },
    { to: "sw2", switch: "sw1", mode: "trunk", allowed: [10] },
  ],
};

let clock = 0;
function setup(topology: Topology) {
  const monitor = new NetMonitor({ now: () => clock });
  monitor.configure(topology);
  const machines = new Map<string, FakeMachine>();
  const net = build_topology(topology, {
    create_machine: (desc) => {
      const machine = new FakeMachine();
      machines.set(desc.id, machine);
      return monitor.wrap(desc.id, machine);
    },
  });
  const machine = (id: string): FakeMachine => {
    const found = machines.get(id);
    if (!found) throw new Error(`no machine ${id}`);
    return found;
  };
  const count = (key: string): number => monitor.getSnapshot().counts.get(key) ?? 0;
  return { monitor, net, machine, count };
}

describe("NetMonitor", () => {
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("counts a frame from machine A to machine B on both machine links, and the trunk when they are on two switches", () => {
    const { machine, count } = setup(TWO_SWITCHES);
    const flush = () => vi.advanceTimersByTime(NET_PUBLISH_MS);
    // The switches learn where pc2 and pc3 are, so the next frames are unicast.
    machine("pc2").send(frame(BROADCAST, mac(2)));
    machine("pc3").send(frame(BROADCAST, mac(3)));
    flush();
    const keys = ["machine:pc1", "machine:pc2", "machine:pc3", "trunk:sw1|sw2"];
    const mark = keys.map(count);
    const delta = () => keys.map((key, at) => count(key) - (mark[at] ?? 0));

    machine("pc1").send(frame(mac(2), mac(1)));
    flush();
    expect(delta()).toEqual([1, 1, 0, 0]);
    expect(machine("pc2").received.at(-1)).toHaveLength(64);

    machine("pc1").send(frame(mac(3), mac(1)));
    flush();
    expect(delta()).toEqual([2, 1, 1, 1]);
  });

  it("counts the trunk once per frame, whatever number of machines behind it receive", () => {
    const { machine, count } = setup({
      ...TWO_SWITCHES,
      machines: [...TWO_SWITCHES.machines, { id: "pc4", profile: "net" }],
      links: [...TWO_SWITCHES.links, { machine: "pc4", switch: "sw2", mode: "access", vlan: 10 }],
    });
    machine("pc1").send(frame(BROADCAST, mac(1)));
    vi.advanceTimersByTime(NET_PUBLISH_MS);
    expect(count("machine:pc1")).toBe(1);
    for (const id of ["pc2", "pc3", "pc4"]) expect(count(`machine:${id}`)).toBe(1);
    expect(count("trunk:sw1|sw2")).toBe(1);
  });

  it("does not count a trunk for frames that stay on one switch", () => {
    const { machine, count } = setup(TWO_SWITCHES);
    machine("pc1").send(frame(mac(2), mac(1)));
    vi.advanceTimersByTime(NET_PUBLISH_MS);
    expect(count("trunk:sw1|sw2")).toBe(1); // unknown unicast floods to pc3 across the trunk
    machine("pc2").send(frame(mac(1), mac(2)));
    vi.advanceTimersByTime(NET_PUBLISH_MS);
    expect(count("trunk:sw1|sw2")).toBe(1); // pc1 is known now: the reply stays on sw1
  });

  it("publishes at most once per interval and keeps the newest 500 frames with cut bytes", () => {
    const { monitor, machine } = setup(TWO_SWITCHES);
    const seen = vi.fn();
    monitor.subscribe(seen);
    for (let i = 0; i < FRAME_LOG_LIMIT + 20; i++) machine("pc1").send(Uint8Array.from({ length: 400 }, (_, at) => (at < 12 ? 1 : i % 256)));
    expect(seen).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(NET_PUBLISH_MS);
    expect(seen).toHaveBeenCalledTimes(1);
    const log = monitor.getSnapshot().frames.get("pc1") ?? [];
    expect(log).toHaveLength(FRAME_LOG_LIMIT);
    expect(log[0]?.bytes).toHaveLength(CAPTURED_BYTES);
    expect(log[0]?.length).toBe(400);
    clock += 10;
    machine("pc1").send(frame(BROADCAST, mac(1)));
    vi.advanceTimersByTime(NET_PUBLISH_MS - 11);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("stops counting after the topology is torn down and leaves no timer after dispose", () => {
    const { net, machine, count, monitor } = setup(TWO_SWITCHES);
    machine("pc1").send(frame(BROADCAST, mac(1)));
    net.teardown();
    machine("pc1").send(frame(BROADCAST, mac(1)));
    vi.advanceTimersByTime(NET_PUBLISH_MS);
    expect(count("machine:pc1")).toBe(1);
    monitor.dispose();
    machine("pc2").send(frame(BROADCAST, mac(2)));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keys links the same way for the diagram", () => {
    expect(linkKey({ machine: "pc1", switch: "sw1", mode: "access", vlan: 1 })).toBe("machine:pc1");
    expect(linkKey({ to: "sw1", switch: "sw2", mode: "trunk", allowed: [1] })).toBe("trunk:sw1|sw2");
    expect(linkKey({ uplink: "relay", switch: "sw1", mode: "access", vlan: 1 })).toBe("uplink:sw1");
  });
});
