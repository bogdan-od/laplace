# Laplace

Linux in the browser on the [v86](https://github.com/copy/v86) emulator, with deterministic session recording and replay. A session is a journal of input events plus snapshots: it can be replayed to the exact instruction, rewound, continued from any moment, verified and shown to a teacher. Machines of a class are connected by a network between browsers.

![The player: a recorded session with the command list and the timeline](docs/screenshot.png)

## Features

- Deterministic core: the same journal gives the same guest state on every host, checked by digests of guest memory.
- Rewind, "continue from here", rollback to any earlier command, and a player with a timeline and command search.
- Teacher and student roles: classes, assignments, a calendar, live terminals of the whole group, takeover of student input, help requests, submissions, grades, lessons with explanations and "try it yourself" segments.
- Networks of up to six machines per topology: switches with VLANs, a router, NAT, between browsers over WebRTC with a server fallback, and optional Internet access through a relay.
- A server that replays submitted journals itself to check them.
- Images: Buildroot, a small network image (iproute2, iptables, dnsmasq, tcpdump, BIRD), Alpine, and an Alpine image for study with compilers and manual pages.

## Quick start

Requires Node.js 22 or newer.

```
npm run setup      # installs the root, server and web dependencies
npm run images     # downloads the boot snapshots, kernels and file systems into images/
npm run build      # builds the server and the web UI
(cd server && npm run demo:reset)   # fills a database with demo data
npm start          # http://127.0.0.1:8086
```

Demo accounts: `teacher` / `teacher-demo`, `student01` ... `student24` / `student-demo`. The interface is in Ukrainian.

`npm run images` takes about 420 MB from the GitHub release named in `images.json`. Choose profiles with `npm run images -- study net`, point it at another location with `LAPLACE_IMAGES_URL`, or build the files yourself: [docs/images.md](docs/images.md).

State is kept in `data/` in the repository root by default; `LAPLACE_DB` and `LAPLACE_JOURNALS` change the database file and the journal folder, `PORT` the port.

## Layout

| Path | Content |
|------|---------|
| `app/core/` | deterministic core: `engine.mjs`, journal format, snapshots, digests |
| `app/machine/` | `Machine` and its Worker, the guest system channel |
| `app/net/` | switch, topologies, WebRTC mesh, rooms, relay client, frame router |
| `app/profiles.mjs` | image profiles and guest setup commands |
| `app/topologies/` | sample network topologies |
| `app/*.html`, `app/ui/` | minimal pages used to check the core in browsers |
| `app/test/` | Node tests; `app/test/browser/` drives Chromium and Firefox |
| `server/` | NestJS API, SQLite, journal storage, rooms, journal verification |
| `web/` | React UI and its end-to-end scripts (`web/e2e/`) |
| `shared/` | TypeScript types shared by server and web |
| `v86det/` | v86 with the determinism patches (sources of `v86.wasm`) |
| `images-src/` | how the images are built, and the v86 patches against upstream |
| `bench/` | replay and speed benchmarks |
| `vendor/` | the terminal emulator (xterm.js) |
| `docs/` | [architecture](docs/architecture.md), [images](docs/images.md) |

## Tests and benchmarks

```
npm test              # Node core tests, about 3 minutes
npm run test:server   # server tests
npm run test:web      # web UI tests (Vitest)
```

Browser tests need Chromium or Firefox and run one at a time. Record the journal they replay first with `npm run test:browser:prepare`, then run for example `node app/test/browser/machine.test.mjs` or `SKIP=relay_hang node app/test/browser/net.test.mjs`. The end-to-end scripts in `web/e2e/` need the built server and web UI (`npm run build`) and Chromium, for example `node web/e2e/demo.mjs`.

```
npm run bench:replay  # replays the demo journals in Chromium (Firefox: node bench/browser/run-replay.mjs firefox)
npm run bench:speed   # emulator speed
npm run bench:net     # network between machines in the browser
```

## Browsers

Chromium and Firefox are supported and produce identical replays: `bench:replay` checks every digest of the demo journals in either browser.

## License

[AGPL-3.0-only](LICENSE). `v86det/` is derived from v86 and keeps its own license ([v86det/LICENSE](v86det/LICENSE)); `vendor/LICENSE.xterm` covers xterm.js.
