// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { JobRegistry } from '../src/core/registry.js'
import { JobStatus, JobEventType } from '../src/core/types.js'

// We test the polling behavior by directly testing the registry + a mock executor
// The AlchemyOrchestrator requires full initialization which needs SSH etc.
// Instead, we test the polling state machine logic by verifying the registry correctly
// tracks job state transitions that the poll cycle would trigger.

// For the orchestrator polling tests, we will test the startPolling/stopPolling
// interface using a lightweight test harness that wraps the actual Orchestrator.

// Since full Orchestrator init requires plugin setup, we test the poll timer
// behavior through a minimal wrapper.

class MockExecutor {
  type = 'mock'
  statusFn: ReturnType<typeof vi.fn>

  constructor() {
    this.statusFn = vi.fn()
  }

  async status(slurmJobId: string) {
    return this.statusFn(slurmJobId)
  }
}

// Minimal polling harness that replicates the Orchestrator's pollJobs logic
class PollingHarness {
  private pollTimer: NodeJS.Timeout | null = null
  public pollCount = 0
  public executor: MockExecutor
  public registry: JobRegistry
  public terminalHandlerCalls: Array<{ jobId: string; status: JobStatus }> = []

  constructor() {
    this.executor = new MockExecutor()
    this.registry = new JobRegistry(':memory:')
  }

  startPolling(intervalMs: number): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setInterval(() => {
      this.pollJobs().catch(() => { /* swallow */ })
    }, intervalMs)
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  isPolling(): boolean {
    return this.pollTimer !== null
  }

  async pollJobs(): Promise<void> {
    this.pollCount++
    const { jobs } = this.registry.listJobs({
      status: [JobStatus.PENDING, JobStatus.SUBMITTED, JobStatus.RUNNING],
      limit: 200,
    })

    for (const job of jobs) {
      if (!job.slurmJobId) continue
      try {
        const result = await this.executor.status(job.slurmJobId)
        if (result.status === job.status) continue

        this.registry.updateJob(job.id, {
          status: result.status,
          exitCode: result.exitCode,
          node: result.node,
          elapsed: result.elapsed,
        })

        const isTerminal =
          result.status === JobStatus.COMPLETED ||
          result.status === JobStatus.FAILED ||
          result.status === JobStatus.TIMEOUT ||
          result.status === JobStatus.CANCELLED

        if (isTerminal) {
          this.terminalHandlerCalls.push({ jobId: job.id, status: result.status })
        }
      } catch {
        // do not crash the poll cycle
      }
    }
  }

  close() {
    this.stopPolling()
    this.registry.close()
  }
}

const MOCK_SPEC = {
  name: 'test-job',
  command: 'echo hello',
  resources: { partition: 't4', time: '00:10:00', mem: '4G', gpus: 1 },
}

describe('Orchestrator polling - startPolling / stopPolling', () => {
  let harness: PollingHarness

  beforeEach(() => {
    harness = new PollingHarness()
    vi.useFakeTimers()
  })

  afterEach(() => {
    harness.close()
    vi.useRealTimers()
  })

  it('startPolling sets an interval', () => {
    expect(harness.isPolling()).toBe(false)
    harness.startPolling(1000)
    expect(harness.isPolling()).toBe(true)
  })

  it('startPolling is idempotent (calling twice does not create extra timer)', () => {
    harness.startPolling(1000)
    harness.startPolling(1000) // second call should be no-op
    expect(harness.isPolling()).toBe(true)
    harness.stopPolling()
    expect(harness.isPolling()).toBe(false)
  })

  it('stopPolling clears the interval', () => {
    harness.startPolling(1000)
    harness.stopPolling()
    expect(harness.isPolling()).toBe(false)
  })

  it('poll fires after interval elapses', async () => {
    harness.executor.statusFn.mockResolvedValue({ status: JobStatus.RUNNING })
    harness.startPolling(5000)
    expect(harness.pollCount).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    harness.stopPolling()
    expect(harness.pollCount).toBeGreaterThanOrEqual(1)
  })

  it('poll does not fire before interval', () => {
    harness.startPolling(5000)
    vi.advanceTimersByTime(4999)
    expect(harness.pollCount).toBe(0)
  })

  it('poll fires multiple times', async () => {
    harness.executor.statusFn.mockResolvedValue({ status: JobStatus.RUNNING })
    harness.startPolling(1000)
    await vi.advanceTimersByTimeAsync(3000)
    harness.stopPolling()
    expect(harness.pollCount).toBeGreaterThanOrEqual(3)
  })
})

describe('Orchestrator polling - status transitions', () => {
  let harness: PollingHarness

  beforeEach(() => {
    harness = new PollingHarness()
    vi.useFakeTimers()
  })

  afterEach(() => {
    harness.close()
    vi.useRealTimers()
  })

  it('when status changes from RUNNING → COMPLETED, handleTerminalJob is triggered', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: '123' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.COMPLETED,
      exitCode: 0,
      node: 'gpu-01',
      elapsed: 90,
    })

    await harness.pollJobs()

    const updatedJob = harness.registry.getJob(jobId)
    expect(updatedJob.status).toBe(JobStatus.COMPLETED)
    expect(harness.terminalHandlerCalls).toHaveLength(1)
    expect(harness.terminalHandlerCalls[0]).toMatchObject({ jobId, status: JobStatus.COMPLETED })
  })

  it('when status is unchanged, no update occurs', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: '456' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.RUNNING,
      exitCode: null,
      node: null,
      elapsed: null,
    })

    const beforeUpdatedAt = harness.registry.getJob(jobId).updatedAt

    await harness.pollJobs()

    const job = harness.registry.getJob(jobId)
    expect(job.updatedAt).toBe(beforeUpdatedAt)
    expect(harness.terminalHandlerCalls).toHaveLength(0)
  })

  it('RUNNING → FAILED triggers terminal handler', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: '789' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.FAILED,
      exitCode: 1,
      node: 'gpu-02',
      elapsed: 30,
    })

    await harness.pollJobs()

    expect(harness.terminalHandlerCalls[0]).toMatchObject({ jobId, status: JobStatus.FAILED })
  })

  it('RUNNING → TIMEOUT triggers terminal handler', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: 'timeout-job' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.TIMEOUT,
      exitCode: 124,
      node: 'gpu-03',
      elapsed: 3600,
    })

    await harness.pollJobs()

    expect(harness.terminalHandlerCalls[0]).toMatchObject({ jobId, status: JobStatus.TIMEOUT })
  })

  it('SUBMITTED → RUNNING does not trigger terminal handler', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.SUBMITTED, slurmJobId: 'sub-job' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.RUNNING,
      exitCode: null,
      node: 'gpu-04',
      elapsed: null,
    })

    await harness.pollJobs()

    const job = harness.registry.getJob(jobId)
    expect(job.status).toBe(JobStatus.RUNNING)
    expect(harness.terminalHandlerCalls).toHaveLength(0)
  })

  it('handles executor.status() throwing without crashing the poll cycle', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: 'err-job' })

    harness.executor.statusFn.mockRejectedValue(new Error('SSH connection lost'))

    // Should not throw
    await expect(harness.pollJobs()).resolves.toBeUndefined()

    // Job status should remain unchanged
    expect(harness.registry.getJob(jobId).status).toBe(JobStatus.RUNNING)
  })

  it('handles multiple jobs in one poll cycle', async () => {
    const id1 = harness.registry.createJob(MOCK_SPEC, 'mock')
    const id2 = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(id1, { status: JobStatus.RUNNING, slurmJobId: 'job-1' })
    harness.registry.updateJob(id2, { status: JobStatus.SUBMITTED, slurmJobId: 'job-2' })

    harness.executor.statusFn.mockImplementation(async (slurmId: string) => {
      if (slurmId === 'job-1') return { status: JobStatus.COMPLETED, exitCode: 0, node: 'gpu-01', elapsed: 60 }
      if (slurmId === 'job-2') return { status: JobStatus.RUNNING, exitCode: null, node: 'gpu-02', elapsed: null }
      return { status: JobStatus.UNKNOWN, exitCode: null, node: null, elapsed: null }
    })

    await harness.pollJobs()

    expect(harness.registry.getJob(id1).status).toBe(JobStatus.COMPLETED)
    expect(harness.registry.getJob(id2).status).toBe(JobStatus.RUNNING)
    expect(harness.terminalHandlerCalls).toHaveLength(1)
    expect(harness.terminalHandlerCalls[0]?.jobId).toBe(id1)
  })

  it('jobs without slurmJobId are skipped', async () => {
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    // Do NOT set slurmJobId
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING })

    harness.executor.statusFn.mockResolvedValue({ status: JobStatus.COMPLETED })

    await harness.pollJobs()

    // executor.status should NOT have been called
    expect(harness.executor.statusFn).not.toHaveBeenCalled()
  })
})

describe('Orchestrator polling - interval with fake timers', () => {
  it('poll cycle fires and updates job status on interval', async () => {
    vi.useFakeTimers()

    const harness = new PollingHarness()
    const jobId = harness.registry.createJob(MOCK_SPEC, 'mock')
    harness.registry.updateJob(jobId, { status: JobStatus.RUNNING, slurmJobId: 'timer-job' })

    harness.executor.statusFn.mockResolvedValue({
      status: JobStatus.COMPLETED,
      exitCode: 0,
      node: 'gpu-01',
      elapsed: 45,
    })

    harness.startPolling(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    harness.stopPolling()

    expect(harness.pollCount).toBeGreaterThanOrEqual(1)

    harness.close()
    vi.useRealTimers()
  })
})
