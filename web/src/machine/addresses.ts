// The addresses of a machine as the student sees them, read from the setup command that configured it
// (`ifconfig eth0 hw ether aa:bb:... 10.0.0.1 netmask 255.255.255.0 up`, `ip addr add 10.0.0.1/24 ...`).

export interface MachineAddresses {
  mac: string | null;
  /** IPv4 addresses, with the prefix when the command wrote one. */
  ips: string[];
}

const MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g;
/** `netmask 255.255.255.0` and `broadcast 10.0.0.255` hold dotted numbers that are not addresses of the machine. */
const NOT_ADDRESSES = /\b(?:netmask|broadcast)\s+\S+/gi;

export function machineAddresses(setup: string): MachineAddresses {
  const mac = MAC.exec(setup)?.[0] ?? null;
  const rest = setup.replace(NOT_ADDRESSES, " ");
  return { mac, ips: [...new Set(rest.match(IPV4) ?? [])] };
}
