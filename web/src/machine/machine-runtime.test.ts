import { describe, expect, it } from "vitest";
import { MachineRuntime } from "./machine-runtime";
import type { MachineLike } from "./machine-types";

type SetupResult = { rc: number; output: string } | null;

function runtimeWith(result: SetupResult): MachineRuntime {
  const machine = {
    dead: false,
    status: null,
    mirror: [],
    on: () => undefined,
    begin_session: async () => null,
    run_setup: async () => result,
  } as unknown as MachineLike;
  return new MachineRuntime({ node: "m1", title: "m1", machine, fresh: true });
}

describe("MachineRuntime.beginSession network phase", () => {
  it("is ready when the setup command exits with code 0", async () => {
    const runtime = runtimeWith({ rc: 0, output: "" });
    await runtime.beginSession("ifconfig eth0 hw ether 02:00:00:00:00:01 up\n");
    expect(runtime.getView().network).toBe("ready");
    expect(runtime.getView().notice).toBeNull();
  });

  it("fails and shows the guest's message when the setup command exits with a nonzero code", async () => {
    const runtime = runtimeWith({ rc: 1, output: "ifconfig: SIOCSIFHWADDR: Device or resource busy\n" });
    await runtime.beginSession("ifconfig eth0 hw ether 02:00:00:00:00:01 up\n");
    expect(runtime.getView().network).toBe("failed");
    expect(runtime.getView().notice).toContain("код 1");
    expect(runtime.getView().notice).toContain("Device or resource busy");
  });

  it("fails when the setup command got no answer", async () => {
    const runtime = runtimeWith(null);
    await runtime.beginSession("ifconfig eth0 hw ether 02:00:00:00:00:01 up\n");
    expect(runtime.getView().network).toBe("failed");
  });
});

describe("MachineRuntime input during the session start", () => {
  function live(setup: Promise<SetupResult>): { runtime: MachineRuntime; typed: string[] } {
    const typed: string[] = [];
    const machine = {
      dead: false,
      status: { mode: "live" },
      user_paused: false,
      mirror: [],
      on: () => undefined,
      type: (data: string) => void typed.push(data),
      begin_session: async () => null,
      run_setup: () => setup,
    } as unknown as MachineLike;
    return { runtime: new MachineRuntime({ node: "m1", title: "m1", machine, fresh: true }), typed };
  }

  it("takes no student or teacher input from the hold until the setup has answered", async () => {
    let answer: (result: SetupResult) => void = () => undefined;
    const { runtime, typed } = live(new Promise((resolve) => (answer = resolve)));
    runtime.holdInput();
    expect(runtime.getView().settingUp).toBe(true);
    expect(runtime.getView().canType).toBe(false);
    const started = runtime.beginSession("ifconfig eth0 hw ether 02:00:00:00:00:01 up\n");
    expect(runtime.type("ifconfig eth0 up\n")).toBe(false);
    expect(runtime.teacherInput(0, "ls\n")).toBe(false);
    answer({ rc: 0, output: "" });
    await started;
    expect(runtime.getView().settingUp).toBe(false);
    expect(runtime.type("ls\n")).toBe(true);
    expect(typed).toEqual(["ls\n"]);
  });

  it("releases the input when the setup got no answer", async () => {
    const { runtime } = live(Promise.resolve(null));
    await runtime.beginSession("ifconfig eth0 hw ether 02:00:00:00:00:01 up\n");
    expect(runtime.getView().settingUp).toBe(false);
    expect(runtime.getView().canType).toBe(true);
  });
});
