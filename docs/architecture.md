# Architecture

Laplace runs Linux in the browser on the v86 emulator. Every session is a deterministic journal of input events: it can be replayed to the exact instruction, rewound, continued from any moment, verified, and shown to a teacher. Machines of several students are connected by a network between browsers.

## Layers

```
web/        React UI (teacher, student, player)        -> uses app/machine, app/net
server/     NestJS API, SQLite, journal store, rooms   -> serves web/dist and images/
app/        core, machine (Worker), network, profiles  -> plain ES modules, no npm dependencies
v86det/     v86 with determinism patches (Rust -> v86.wasm, JS)
images/     boot snapshots, kernels, root file systems (downloaded, not in git)
```

`app/core` has no Node API and no DOM, so the same file runs in Node tests, in a Worker, and in a browser tab.

## Core: `app/core/engine.mjs`

One machine per process or Worker. Determinism replaces the globals `Math.random`, `crypto.getRandomValues`, `Date`, `WebAssembly.instantiate`, `v86.microtick` and `v86.prototype.yield`, so two machines cannot share a global scope. A Worker has no restriction on synchronous wasm compilation, which lets snapshots with JIT modules be restored the same way as in Node.

```js
const m = create_machine({ config, seed, epoch, events = [], next = 0, snapshot = null,
                           on_journal_end = "pause" | "live", check_every_ms = 10000, snap_every_ms = 0 });
await m.ready;
m.type(data, by)      // live: input goes to a queue and into the journal at the chunk boundary
m.net_in(frame)       // live: a frame goes to a queue
m.set_speed(x)        // replay: 1 = real time, 0 = maximum
m.pause(); m.resume(); m.go_live();
await m.run_until(vtime_ms)
await m.snapshot(sent_hashes)
m.events; m.status()
```

Modes: `replay` (events come from the journal, live input is ignored), then `paused` or `live` after the last event. `live` is recording. A pause stops only the yield, so guest time does not advance.

### Time

The guest never sees the host clock. Events sit on chunk boundaries: `c` is the number of executed instructions, `w` the accumulated idle time in ms. Guest time of an event is instruction time under the journaled rates plus `w`. A `clock` event is a jump of the guest clock and a `rate` event sets a new instructions-per-ms rate. Host waits (a 9p reply, an image file) do not count in `w`: in virtual time the reply arrives instantly.

### Random numbers and host differences

`header.seed` is the seed of the guest random stream (RDRAND, `crypto.getRandomValues`). A cold start uses it as the initial state; a start from a boot snapshot reseeds the stream right after restoring, so each new session from one snapshot gets its own seed. Continuing, rollback and restoring never change the seed.

NaN results of SSE operations in `v86det` follow x86 rules (the first NaN operand with the quiet bit set, otherwise the default NaN), and x87 sin/cos/tan/atan/log results are reduced to the "real indefinite" value, so the guest cannot see the host CPU. The optional header field `host_nan` records the NaN sign of the recording host and is used only to explain a divergence.

## Snapshots

A snapshot is the device state, all wasm memory in 64 KB chunks, the JIT modules and the clock. Guest RAM is excluded from `save_state` (`cpu.pack_memory` is replaced during the snapshot) because memory is stored whole anyway. Chunks are addressed by content hash; the store on the main thread keeps each chunk once, and a Worker never resends a chunk whose hash it already sent.

The hash is `app/core/digest.mjs`: a fast 64-bit digest (two 32-bit lanes) that is identical in Node and in the browser. A check event carries two of them: `h` for guest RAM and `m` for the rest of wasm memory (CPU registers including xmm, JIT tables, device state kept in wasm memory). The 8 bytes of `current_tsc` are excluded from `m`.

After restoring a snapshot in the middle of a journal (`next > 0`) only `h` is compared, because a 9p image file read again by the guest and the zstd unpacking shift the Rust heap. A live recording that continues such a snapshot writes `NO_REST_DIGEST` (`0000000000000000`), which means "do not compare".

`app/core/snapfile.mjs` writes a snapshot to a file and reads it back (a JSON header plus blocks, gzip through `CompressionStream`).

## Journal format `v86-replay/9`

```json
{ "header": { "format": "v86-replay/9", "profile": "buildroot|net|alpine|study", "machine": "name", "seed": 123,
              "epoch": 1762700000000, "host_nan": "neg",
              "start": null | {"snapshot": "alpine-boot", "digest": "..."},
              "parent": null | {"digest": "<digest of the parent journal>", "event": 812} },
  "events": [ {"c": 1234567, "w": 12.5, "t": "serial", "data": "ls\r", "by": "teacher", "p": 2}, ... ] }
```

| Event | Fields | Meaning |
|-------|--------|---------|
| `clock` | `extra` | jump of the guest clock |
| `rate` | `per_ms` | new instruction rate |
| `serial` | `data`, `by?`, `p?` | input on a serial port; `by` absent = student, `p` is the port 0, 1 or 2 (absent = 0) |
| `net` | `data` | incoming Ethernet frame, base64 |
| `check` | `h`, `m` | digests of guest RAM and the rest of wasm memory |

Within one chunk the order is fixed: all input in queue order (ports mixed), then network frames, then `check`. Replay throws if an event falls on an already passed counter or a `check` does not match; the message says which part diverged. `check_journal_strict` validates someone else's journal before replay on the server (fields by type, bounds, order, sizes). A journal may carry `header.lesson`, an array of `{t:"note", at, text}` and `{t:"self", from, to, text}` segments (event indexes) used by the lesson mode of the player.

Output of the guest is not journaled: it is a function of the input.

## Machine and Worker

- `app/machine/worker.mjs` is the Worker entry. Requests: `start`, `type`, `net_in`, `speed`, `pause`, `resume`, `run_until`, `go_live`, `snapshot`, `journal`. Replies: `ready`, `serial`, `net_out`, `status` (at most 10 per second), `end`, `error`, `snapshot`, `journal`, `done {id}`.
- `app/machine/machine.mjs` is the `Machine` class on the main thread: it owns the Worker, the snapshot store with reference counts, automatic snapshots, and `seek(vtime)` (the nearest snapshot not later than `vtime`, a new Worker from it, then `run_until`).
- Rewinding is a new Worker from a snapshot, not a restore inside a running emulator. Rollback in a live session starts a Worker from the nearest snapshot before the chosen command, replays to it, and goes live; the journal after rollback is the events before the command plus the new ones, so it is self-contained.
- Start of a session is from a boot snapshot (`images/<profile>-boot.snap`) made by the same core in Node, because a cold boot of Alpine takes minutes.

### Serial ports and the system channel

The guest has three serial ports: `ttyS0` is the student console, `ttyS1` the system channel, `ttyS2` the teacher terminal (a root shell with a controlling terminal, so Ctrl-C, job control and `vi` work). One setup line typed before the boot snapshot is taken starts the agent and the teacher shell through `setsid`.

The agent protocol (`app/machine/agent_channel.mjs`) runs on `ttyS1`: a request is `@req <id> <base64 command>`, a reply is `@res <id> <return code> <base64 output>` (up to 64 KiB of output). `Machine.system(command)` uses it to set the date, the MAC address, the network and to reseed the guest random generator at the start of every live session (`session_command` in `app/profiles.mjs`, with the binary from `images-src/reseed/`). System input is journaled as `serial` events with `p: 1` and `by: "system"`, so replay is deterministic.

## Network

Frames are Ethernet frames at layer 2. The guest NIC is an NE2000 with no relay inside the emulator. A Worker hands out frames (`net_out`) only in live mode, and every machine writes the frames that reach it into its own journal as `net` events, so each machine replays alone. The switch on the page is not deterministic and does not need to be: during replay a machine neither sends nor receives frames, like an unplugged cable.

- `app/net/switch.mjs`: a switch with VLANs (access and trunk ports, 802.1Q tags, a MAC table per VLAN).
- `app/net/topology.mjs`: validation and assembly of a `v86-topology/1` description (1 to 6 machines, switches, access/trunk links, at most one uplink to the relay, no loops). `app/net/topology_journals.mjs` launches a topology from a set of journals ("broken topology" assignments): all machines replay their journals at maximum speed and go live together.
- `app/net/mesh.mjs` and `app/net/room.mjs`: frames between browsers go over WebRTC DataChannels with signaling through the server; when a channel does not open within 5 seconds or breaks, frames go through the server as `frame` messages.
- `app/net/router.mjs` decides where a frame goes: broadcast and multicast to neighbors and the relay, a known neighbor MAC only to it, a MAC learned behind the relay only to the relay, an unknown one to everyone.
- `app/net/relay.mjs`: Internet access through a relay (one binary WebSocket message is one Ethernet frame, the relay provides DHCP). The address comes from `app/config.json` (`{"relay": "wss://..."}`, `null` means no Internet) or from the page parameter `?relay=<url>` / `?relay=off`.

A frame in flight at the moment of a pause is lost for the machine that was already paused; it behaves like a lost packet.

## Server

`server/` is a NestJS application with SQLite (`node:sqlite`). Modules: auth and sessions, classes and invites, a content library, assignments and calendar, attempts and branches, journal storage, help requests and review, rooms (WebSocket), LTI, and a runner that verifies journals by replaying them in the Node core. `GET /files/images/...` serves boot snapshots and kernels, and `web/dist` is served as the single-page application. `npm run demo:reset` in `server/` fills a database with demo data; `LAPLACE_DB` and `LAPLACE_JOURNALS` choose where state lives.

The server never trusts a journal: before replaying it runs the strict check, and the verification result is stored with the attempt.

## Web UI

`web/` is a React application (Vite, Tailwind). Roles: a student works in a terminal and can roll back or ask for help; a teacher sees the terminals of a group live, takes over input, reviews submissions and replays them; the player replays any journal with speed control, a timeline over automatic snapshots, a command list with search, "continue from here" (a new journal with a `parent`), and verification. The pages under `web/src/machine` adapt the Worker-based `Machine` to the UI. The minimal pages `app/*.html` exercise the core without the UI and are used by the browser tests in `app/test/browser`.

## Profiles

`app/profiles.mjs` holds the v86 configuration of each image: `buildroot` (64 MB), `net` (64 MB, a custom Buildroot with VLAN, iptables, tcpdump, nc and httpd), `alpine` (128 MB, root over 9p) and `study` (Alpine with development tools and manual pages). How they are built: [images.md](images.md).
