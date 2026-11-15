import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as JournalModule from '@core/core/journal.mjs';
import type * as AgentChannelModule from '@core/machine/agent_channel.mjs';
import type * as ProfilesModule from '@core/profiles.mjs';
import type * as HostNanModule from '@core/core/host_nan.mjs';
import type * as SnapfileModule from '@core/core/snapfile.mjs';
import type * as MacModule from '@core/net/mac.mjs';
import type * as TopologyModule from '@core/net/topology.mjs';
import type * as TopologyJournalsModule from '@core/net/topology_journals.mjs';
import { repoRoot } from './repo-root';

// The native require loads the ESM core (Node >= 22.12, no top-level await in the core). Unlike
// `import ... from '@core/...'` it works the same in `node dist`, where `nest build` rewrites the
// alias into a path that does not exist. Jest 30 on Node 22 refuses require(esm) even through
// createRequire, so core.spec.ts checks the same calls in a child process.
// The `@core/*` alias is therefore for types only (see the lint rule). Never load engine.mjs here.
const nativeRequire = createRequire(__filename);

function loadCore<T>(file: string): T {
  return nativeRequire(join(repoRoot(), 'app', file)) as T;
}

export const journalCore = (): typeof JournalModule =>
  loadCore('core/journal.mjs');
export const topologyCore = (): typeof TopologyModule =>
  loadCore('net/topology.mjs');
export const topologyJournalsCore = (): typeof TopologyJournalsModule =>
  loadCore('net/topology_journals.mjs');
export const agentChannelCore = (): typeof AgentChannelModule =>
  loadCore('machine/agent_channel.mjs');

// Used by the demo recorder only (src/demo): the boot snapshot clock, the host NaN sign, the session commands.
export const snapfileCore = (): typeof SnapfileModule =>
  loadCore('core/snapfile.mjs');
export const hostNanCore = (): typeof HostNanModule =>
  loadCore('core/host_nan.mjs');
export const macCore = (): typeof MacModule => loadCore('net/mac.mjs');
export const profilesCore = (): typeof ProfilesModule =>
  loadCore('profiles.mjs');
