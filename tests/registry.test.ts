// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JobRegistry } from '../src/core/registry.js'
import {
  JobSpec,
  JobStatus,
  JobEventType,
  ChainSpec,
  ChainStrategyType,
  ChainStatus,
} from '../src/core/types.js'
import { JobNotFoundError, ChainNotFoundError } from '../src/core/errors.js'

const TEST_SPEC: JobSpec = {
  name: 'test-job',
  command: 'echo hello',
  resources: { partition: 't4', time: '00:10:00', mem: '4G', gpus: 1 },
}

const CHAIN_SPEC: ChainSpec = {
  name: 'test-chain',
  strategy: ChainStrategyType.SEQUENTIAL,
  steps: [
    {
      stepId: 'step1',
      job: { ...TEST_SPEC, name: 'step1-job' },
    },
    {
      stepId: 'step2',
      job: { ...TEST_SPEC, name: 'step2-job' },
      dependsOn: ['step1'],
    },
  ],
}

let registry: JobRegistry

beforeEach(() => {
  registry = new JobRegistry(':memory:')
})

afterEach(() => {
  registry.close()
})

describe('JobRegistry - Job CRUD', () => {
  it('createJob returns a UUID string', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('createJob → getJob roundtrip', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    const job = registry.getJob(id)
    expect(job.id).toBe(id)
    expect(job.status).toBe(JobStatus.PENDING)
    expect(job.spec.name).toBe(TEST_SPEC.name)
    expect(job.executorType).toBe('local')
    expect(job.slurmJobId).toBeNull()
    expect(job.metrics).toBeNull()
  })

  it('getJob throws JobNotFoundError for unknown ID', () => {
    expect(() => registry.getJob('nonexistent-id')).toThrow(JobNotFoundError)
  })

  it('updateJob - status transition', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.updateJob(id, { status: JobStatus.RUNNING })
    const job = registry.getJob(id)
    expect(job.status).toBe(JobStatus.RUNNING)
  })

  it('updateJob - sets slurmJobId, exitCode, node, elapsed, logPath', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.updateJob(id, {
      slurmJobId: '12345',
      status: JobStatus.COMPLETED,
      exitCode: 0,
      node: 'gpu-node-01',
      elapsed: 120.5,
      logPath: '/logs/job.out',
    })
    const job = registry.getJob(id)
    expect(job.slurmJobId).toBe('12345')
    expect(job.status).toBe(JobStatus.COMPLETED)
    expect(job.exitCode).toBe(0)
    expect(job.node).toBe('gpu-node-01')
    expect(job.elapsed).toBe(120.5)
    expect(job.logPath).toBe('/logs/job.out')
  })

  it('updateJob - updatedAt changes after update', async () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    const before = registry.getJob(id).updatedAt
    await new Promise(r => setTimeout(r, 5))
    registry.updateJob(id, { status: JobStatus.RUNNING })
    const after = registry.getJob(id).updatedAt
    expect(after >= before).toBe(true)
  })
})

describe('JobRegistry - listJobs', () => {
  it('lists all jobs with no filter', () => {
    registry.createJob(TEST_SPEC, 'local')
    registry.createJob(TEST_SPEC, 'local')
    const { jobs, total } = registry.listJobs()
    expect(total).toBe(2)
    expect(jobs).toHaveLength(2)
  })

  it('filters by status', () => {
    const id1 = registry.createJob(TEST_SPEC, 'local')
    const id2 = registry.createJob(TEST_SPEC, 'local')
    registry.updateJob(id1, { status: JobStatus.RUNNING })
    registry.updateJob(id2, { status: JobStatus.COMPLETED })

    const { jobs: runningJobs } = registry.listJobs({ status: JobStatus.RUNNING })
    expect(runningJobs).toHaveLength(1)
    expect(runningJobs[0]?.id).toBe(id1)

    const { jobs: completedJobs } = registry.listJobs({ status: JobStatus.COMPLETED })
    expect(completedJobs).toHaveLength(1)
    expect(completedJobs[0]?.id).toBe(id2)
  })

  it('filters by multiple statuses', () => {
    const id1 = registry.createJob(TEST_SPEC, 'local')
    const id2 = registry.createJob(TEST_SPEC, 'local')
    registry.updateJob(id1, { status: JobStatus.RUNNING })
    registry.updateJob(id2, { status: JobStatus.COMPLETED })
    registry.createJob(TEST_SPEC, 'local') // pending

    const { jobs, total } = registry.listJobs({ status: [JobStatus.RUNNING, JobStatus.COMPLETED] })
    expect(total).toBe(2)
    expect(jobs.map(j => j.id)).toEqual(expect.arrayContaining([id1, id2]))
  })

  it('filters by chainId', () => {
    const chainId = registry.createChain(CHAIN_SPEC)
    const id1 = registry.createJob(TEST_SPEC, 'local', chainId)
    registry.createJob(TEST_SPEC, 'local') // not in chain

    const { jobs } = registry.listJobs({ chainId })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.id).toBe(id1)
  })

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      registry.createJob(TEST_SPEC, 'local')
    }
    const { jobs: page1, total } = registry.listJobs({ limit: 2, offset: 0 })
    expect(total).toBe(5)
    expect(page1).toHaveLength(2)

    const { jobs: page2 } = registry.listJobs({ limit: 2, offset: 2 })
    expect(page2).toHaveLength(2)
    // No overlap between pages
    const ids1 = page1.map(j => j.id)
    const ids2 = page2.map(j => j.id)
    expect(ids1.some(id => ids2.includes(id))).toBe(false)
  })
})

describe('JobRegistry - getJobBySlurmId', () => {
  it('returns null when not found', () => {
    const result = registry.getJobBySlurmId('999999')
    expect(result).toBeNull()
  })

  it('returns job after setting slurmJobId', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.updateJob(id, { slurmJobId: '42000' })
    const job = registry.getJobBySlurmId('42000')
    expect(job).not.toBeNull()
    expect(job?.id).toBe(id)
    expect(job?.slurmJobId).toBe('42000')
  })
})

describe('JobRegistry - Events', () => {
  it('addEvent → getEvents returns events in order', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.addEvent({ jobId: id, type: JobEventType.CREATED, timestamp: '2024-01-01T00:00:00Z', payload: { msg: 'first' } })
    registry.addEvent({ jobId: id, type: JobEventType.SUBMITTED, timestamp: '2024-01-01T00:01:00Z', payload: { slurmId: '123' } })

    const events = registry.getEvents(id)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe(JobEventType.CREATED)
    expect(events[1]?.type).toBe(JobEventType.SUBMITTED)
    expect(events[1]?.payload).toMatchObject({ slurmId: '123' })
  })

  it('events appear in job record context (getEvents)', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.addEvent({
      jobId: id,
      type: JobEventType.STARTED,
      timestamp: new Date().toISOString(),
      payload: { node: 'gpu01' },
    })
    const events = registry.getEvents(id)
    expect(events.some(e => e.type === JobEventType.STARTED)).toBe(true)
  })

  it('returns empty events for job with no events', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    expect(registry.getEvents(id)).toHaveLength(0)
  })
})

describe('JobRegistry - Chain CRUD', () => {
  it('createChain returns a UUID', () => {
    const id = registry.createChain(CHAIN_SPEC)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('createChain → getChain roundtrip', () => {
    const id = registry.createChain(CHAIN_SPEC)
    const chain = registry.getChain(id)
    expect(chain.id).toBe(id)
    expect(chain.status).toBe(ChainStatus.PENDING)
    expect(chain.spec.name).toBe(CHAIN_SPEC.name)
    expect(chain.jobIds).toHaveLength(0)
  })

  it('getChain throws ChainNotFoundError for unknown ID', () => {
    expect(() => registry.getChain('nonexistent')).toThrow(ChainNotFoundError)
  })

  it('linkJobToChain → getChain has jobIds', () => {
    const chainId = registry.createChain(CHAIN_SPEC)
    const jobId1 = registry.createJob(TEST_SPEC, 'local', chainId, 0, 'step1')
    const jobId2 = registry.createJob(TEST_SPEC, 'local', chainId, 1, 'step2')

    registry.linkJobToChain(chainId, jobId1, 'step1', 0)
    registry.linkJobToChain(chainId, jobId2, 'step2', 1)

    const chain = registry.getChain(chainId)
    expect(chain.jobIds).toEqual([jobId1, jobId2])
  })

  it('updateChain - status transitions', () => {
    const id = registry.createChain(CHAIN_SPEC)
    registry.updateChain(id, { status: ChainStatus.RUNNING })
    expect(registry.getChain(id).status).toBe(ChainStatus.RUNNING)

    registry.updateChain(id, { status: ChainStatus.COMPLETED })
    expect(registry.getChain(id).status).toBe(ChainStatus.COMPLETED)
  })

  it('getChainJobsByStepId returns map indexed by stepId', () => {
    const chainId = registry.createChain(CHAIN_SPEC)
    const jobId1 = registry.createJob(TEST_SPEC, 'local', chainId, 0, 'step1')
    const jobId2 = registry.createJob(TEST_SPEC, 'local', chainId, 1, 'step2')

    registry.linkJobToChain(chainId, jobId1, 'step1', 0)
    registry.linkJobToChain(chainId, jobId2, 'step2', 1)

    const map = registry.getChainJobsByStepId(chainId)
    expect(map.has('step1')).toBe(true)
    expect(map.has('step2')).toBe(true)
    expect(map.get('step1')?.id).toBe(jobId1)
    expect(map.get('step2')?.id).toBe(jobId2)
  })

  it('getChainJobs returns jobs in position order', () => {
    const chainId = registry.createChain(CHAIN_SPEC)
    const jobId1 = registry.createJob(TEST_SPEC, 'local', chainId, 0, 'step1')
    const jobId2 = registry.createJob(TEST_SPEC, 'local', chainId, 1, 'step2')

    registry.linkJobToChain(chainId, jobId1, 'step1', 0)
    registry.linkJobToChain(chainId, jobId2, 'step2', 1)

    const jobs = registry.getChainJobs(chainId)
    expect(jobs[0]?.id).toBe(jobId1)
    expect(jobs[1]?.id).toBe(jobId2)
  })
})

describe('JobRegistry - Metrics', () => {
  it('setMetrics → getMetrics roundtrip', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.setMetrics(id, { val_acc: 0.92, train_loss: 0.08, epoch: 100 })
    const metrics = registry.getMetrics(id)
    expect(metrics.val_acc).toBeCloseTo(0.92)
    expect(metrics.train_loss).toBeCloseTo(0.08)
    expect(metrics.epoch).toBe(100)
  })

  it('setMetrics → getJob has metrics after updateJob', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.setMetrics(id, { val_acc: 0.88 })
    registry.updateJob(id, { metrics: { val_acc: 0.88 } })
    const job = registry.getJob(id)
    expect(job.metrics?.val_acc).toBeCloseTo(0.88)
  })

  it('setMetrics upserts (updates existing key)', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    registry.setMetrics(id, { val_acc: 0.5 })
    registry.setMetrics(id, { val_acc: 0.9 })
    const metrics = registry.getMetrics(id)
    expect(metrics.val_acc).toBeCloseTo(0.9)
  })

  it('getMetrics returns empty object for job with no metrics', () => {
    const id = registry.createJob(TEST_SPEC, 'local')
    const metrics = registry.getMetrics(id)
    expect(Object.keys(metrics)).toHaveLength(0)
  })
})
