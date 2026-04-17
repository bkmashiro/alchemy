// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// We need to mock child_process before importing TunnelManager
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  }
})

import * as childProcess from 'node:child_process'
import { TunnelManager } from '../src/tunnel/manager.js'

// Helper to create a fake ChildProcess
function makeFakeProcess(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  pid: number
} {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.pid = 12345
  return proc
}

// Make execFile call the callback (node-style) — promisify wraps this
function mockExecFileSuccess() {
  vi.mocked(childProcess.execFile).mockImplementation((_cmd: any, _args: any, callback: any) => {
    // Support both (cmd, callback) and (cmd, args, callback) forms
    const cb = typeof callback === 'function' ? callback : _args
    if (typeof cb === 'function') cb(null, '/usr/bin/found', '')
    return {} as any
  })
}

function mockExecFileFailure() {
  vi.mocked(childProcess.execFile).mockImplementation((_cmd: any, _args: any, callback: any) => {
    const cb = typeof callback === 'function' ? callback : _args
    if (typeof cb === 'function') cb(new Error('not found'), '', '')
    return {} as any
  })
}

function mockExecFileByBin(ngrokOk: boolean, cloudflaredOk: boolean) {
  vi.mocked(childProcess.execFile).mockImplementation((_cmd: any, args: any, callback: any) => {
    const cb = typeof callback === 'function' ? callback : args
    const bin = Array.isArray(args) ? args[0] : ''
    if (typeof cb === 'function') {
      if (bin === 'ngrok') {
        if (ngrokOk) cb(null, '/usr/bin/ngrok', '')
        else cb(new Error('not found'), '', '')
      } else if (bin === 'cloudflared') {
        if (cloudflaredOk) cb(null, '/usr/bin/cloudflared', '')
        else cb(new Error('not found'), '', '')
      } else {
        cb(null, '', '')
      }
    }
    return {} as any
  })
}

describe('TunnelManager.detect()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true for both when which exits 0', async () => {
    mockExecFileSuccess()
    const manager = new TunnelManager()
    const result = await manager.detect()
    expect(result.ngrok).toBe(true)
    expect(result.cloudflared).toBe(true)
  })

  it('returns false when which fails for both', async () => {
    mockExecFileFailure()
    const manager = new TunnelManager()
    const result = await manager.detect()
    expect(result.ngrok).toBe(false)
    expect(result.cloudflared).toBe(false)
  })

  it('detects ngrok but not cloudflared', async () => {
    mockExecFileByBin(true, false)
    const manager = new TunnelManager()
    const result = await manager.detect()
    expect(result.ngrok).toBe(true)
    expect(result.cloudflared).toBe(false)
  })

  it('detects cloudflared but not ngrok', async () => {
    mockExecFileByBin(false, true)
    const manager = new TunnelManager()
    const result = await manager.detect()
    expect(result.ngrok).toBe(false)
    expect(result.cloudflared).toBe(true)
  })
})

describe('TunnelManager.start() - ngrok', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves URL from ngrok JSON line', async () => {
    mockExecFileByBin(true, false)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    // Emit ngrok JSON immediately
    setImmediate(() => {
      const line = JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://abc123.ngrok.io' })
      proc.stdout.emit('data', Buffer.from(line + '\n'))
    })

    const url = await promise
    expect(url).toBe('https://abc123.ngrok.io')
  })

  it('ignores non-matching JSON lines before the tunnel URL line', async () => {
    mockExecFileByBin(true, false)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from('{"lvl":"info","msg":"starting ngrok"}\n'))
      const line = JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://xyz.ngrok.io' })
      proc.stdout.emit('data', Buffer.from(line + '\n'))
    })

    const url = await promise
    expect(url).toBe('https://xyz.ngrok.io')
  })

  it('resolves null when ngrok process exits without providing URL', async () => {
    mockExecFileByBin(true, false)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    setImmediate(() => {
      proc.emit('exit', 1)
    })

    const url = await promise
    expect(url).toBeNull()
  }, 10_000)

  it('resolves null when ngrok emits a process error', async () => {
    mockExecFileByBin(true, false)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    setImmediate(() => {
      proc.emit('error', new Error('spawn ENOENT'))
    })

    const url = await promise
    expect(url).toBeNull()
  }, 10_000)
})

describe('TunnelManager.start() - cloudflared fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to cloudflared when ngrok not found', async () => {
    mockExecFileByBin(false, true)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    setImmediate(() => {
      proc.stderr.emit(
        'data',
        Buffer.from('Some log line\nhttps://random-name.trycloudflare.com - Local server\n'),
      )
    })

    const url = await promise
    expect(url).toBe('https://random-name.trycloudflare.com')
  })

  it('returns null when both ngrok and cloudflared unavailable', async () => {
    mockExecFileFailure()
    const manager = new TunnelManager()
    const url = await manager.start(3000)
    expect(url).toBeNull()
  })
})

describe('TunnelManager.stop()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('kills the process and clears url/state', async () => {
    mockExecFileByBin(true, false)
    const proc = makeFakeProcess()
    vi.mocked(childProcess.spawn).mockReturnValue(proc as any)

    const manager = new TunnelManager()
    const promise = manager.start(3000)

    setImmediate(() => {
      const line = JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://stop-test.ngrok.io' })
      proc.stdout.emit('data', Buffer.from(line + '\n'))
    })

    await promise
    expect(manager.getUrl()).toBe('https://stop-test.ngrok.io')

    manager.stop()
    expect(proc.kill).toHaveBeenCalled()
    expect(manager.getUrl()).toBeNull()
  })

  it('stop() is safe to call when no process is running', () => {
    const manager = new TunnelManager()
    expect(() => manager.stop()).not.toThrow()
    expect(manager.getUrl()).toBeNull()
  })
})
