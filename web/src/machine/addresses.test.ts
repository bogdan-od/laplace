import { describe, expect, it } from "vitest";
import { machineAddresses } from "./addresses";

describe("machineAddresses", () => {
  it("reads the MAC and the address of an ifconfig command and skips the netmask", () => {
    expect(machineAddresses("ifconfig eth0 hw ether aa:bb:cc:dd:ee:01 10.0.0.1 netmask 255.255.255.0 up\n")).toEqual({
      mac: "aa:bb:cc:dd:ee:01",
      ips: ["10.0.0.1"],
    });
  });

  it("keeps the prefix of an ip command", () => {
    expect(machineAddresses("ip addr add 192.168.1.5/24 dev eth0").ips).toEqual(["192.168.1.5/24"]);
  });

  it("returns nothing for a command without addresses", () => {
    expect(machineAddresses("udhcpc -i eth0")).toEqual({ mac: null, ips: [] });
  });
});
