import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Machine } from '@core/machine/machine.mjs'
import { read_journal } from '@core/core/journal.mjs'
import type { ImageManifest } from '@shared/api'

// Check that the build can use the core: replays a recorded journal
// through Machine and shows the serial output. Reachable at /dev/replay.
const journals = import.meta.glob('../../../app/test/out/buildroot-1.json', {
  query: '?raw',
  import: 'default',
})

type State = 'loading' | 'running' | 'ended' | 'failed'

interface Replay {
  output: Uint8Array[]
  state: State
  detail: string
  listeners: Set<() => void>
}

// Outside React: StrictMode mounts effects twice and would start two Workers.
let started: Replay | null = null

function update(r: Replay, state: State, detail = '') {
  r.state = state
  r.detail = detail
  for (const fn of r.listeners) fn()
}

async function run(r: Replay): Promise<void> {
  const [loadJournal] = Object.values(journals)
  if (!loadJournal) throw new Error('app/test/out/buildroot-1.json not found')
  const journal = read_journal(JSON.parse(String(await loadJournal())))
  const images = (await (await fetch('/api/images')).json()) as ImageManifest
  const machine = new Machine({ journal, root: images.root, on_journal_end: 'pause' })
  machine.on('serial', (data) => {
    r.output.push(data)
    update(r, r.state, r.detail)
  })
  machine.on('end', () => update(r, 'ended'))
  machine.on('error', (message) => update(r, 'failed', message))
  machine.set_speed(0)
  update(r, 'running')
  await machine.start()
}

function startReplay(): Replay {
  const r: Replay = { output: [], state: 'loading', detail: '', listeners: new Set() }
  run(r).catch((error: unknown) => {
    update(r, 'failed', error instanceof Error ? error.message : String(error))
  })
  return r
}

export function ReplayPage() {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>('loading')
  const [detail, setDetail] = useState('')

  useEffect(() => {
    const term = new Terminal({ rows: 24, cols: 100, convertEol: true })
    if (host.current) term.open(host.current)
    let written = 0
    let active = true

    const sync = (r: Replay) => {
      if (!active) return
      // After a restart of the replay `serial` re-emits everything, so write only the new tail.
      for (; written < r.output.length; written++) {
        const chunk = r.output[written]
        if (chunk) term.write(chunk)
      }
      setState(r.state)
      setDetail(r.detail)
    }

    started ??= startReplay()
    const r = started
    const listener = () => sync(r)
    r.listeners.add(listener)
    sync(r)

    return () => {
      active = false
      r.listeners.delete(listener)
      term.dispose()
    }
  }, [])

  return (
    <div className="p-4 font-sans">
      <h1 className="mb-2 text-lg">/dev/replay</h1>
      <p data-testid="state" data-state={state}>
        {state}
        {detail ? `: ${detail}` : ''}
      </p>
      <div ref={host} data-testid="terminal" />
    </div>
  )
}
