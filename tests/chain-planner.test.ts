// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ChainPlanner } from '../src/core/chain-planner.js'
import { CyclicDependencyError } from '../src/core/errors.js'
import { ChainSpec, ChainStrategyType, JobStatus, JobRecord, AnalysisResult, ChainStepSpec } from '../src/core/types.js'

function makeSpec(steps: ChainSpec['steps']): ChainSpec {
  return {
    name: 'test-chain',
    strategy: ChainStrategyType.SEQUENTIAL,
    steps,
  }
}

function makeStep(stepId: string, dependsOn?: string[], condition?: string): ChainStepSpec {
  return {
    stepId,
    job: {
      name: stepId,
      command: `echo ${stepId}`,
      resources: { partition: 't4', time: '00:10:00', mem: '4G', gpus: 1 },
    },
    dependsOn,
    condition,
  }
}

function makeJobRecord(id: string, status: JobStatus): JobRecord {
  return {
    id,
    slurmJobId: null,
    spec: {
      name: id,
      command: `echo ${id}`,
      resources: { partition: 't4', time: '00:10:00', mem: '4G', gpus: 1 },
    },
    status,
    executorType: 'local',
    chainId: null,
    chainIndex: null,
    exitCode: null,
    node: null,
    elapsed: null,
    logPath: null,
    metrics: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const planner = new ChainPlanner()

describe('ChainPlanner.validateChain', () => {
  it('accepts a valid chain with no deps', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b'), makeStep('c')])
    expect(() => planner.validateChain(spec)).not.toThrow()
  })

  it('accepts a valid chain with linear deps', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a']), makeStep('c', ['b'])])
    expect(() => planner.validateChain(spec)).not.toThrow()
  })

  it('throws when a step depends on unknown step', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['nonexistent'])])
    expect(() => planner.validateChain(spec)).toThrow(/unknown step/)
  })

  it('throws CyclicDependencyError on direct self-dep', () => {
    // self-dep is a special case — step depends on itself
    const spec = makeSpec([makeStep('a', ['a'])])
    // self-dep: 'a' depends on 'a' which is cyclic
    expect(() => planner.validateChain(spec)).toThrow()
  })

  it('throws CyclicDependencyError on A->B->A cycle', () => {
    const spec = makeSpec([makeStep('a', ['b']), makeStep('b', ['a'])])
    expect(() => planner.validateChain(spec)).toThrow(CyclicDependencyError)
  })

  it('throws CyclicDependencyError on 3-node cycle', () => {
    const spec = makeSpec([
      makeStep('a', ['c']),
      makeStep('b', ['a']),
      makeStep('c', ['b']),
    ])
    expect(() => planner.validateChain(spec)).toThrow(CyclicDependencyError)
  })

  it('throws on duplicate step IDs', () => {
    const spec = makeSpec([makeStep('a'), makeStep('a')])
    expect(() => planner.validateChain(spec)).toThrow(/duplicate/)
  })
})

describe('ChainPlanner.getTopologicalOrder', () => {
  it('returns single-step order', () => {
    const spec = makeSpec([makeStep('a')])
    const order = planner.getTopologicalOrder(spec)
    expect(order).toEqual(['a'])
  })

  it('returns linear order', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a']), makeStep('c', ['b'])])
    const order = planner.getTopologicalOrder(spec)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('returns valid order for diamond shape (a->b, a->c, b->d, c->d)', () => {
    const spec = makeSpec([
      makeStep('a'),
      makeStep('b', ['a']),
      makeStep('c', ['a']),
      makeStep('d', ['b', 'c']),
    ])
    const order = planner.getTopologicalOrder(spec)
    // a must come before b and c; b and c must come before d
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
    expect(order).toHaveLength(4)
  })

  it('throws CyclicDependencyError on cycle', () => {
    const spec = makeSpec([makeStep('a', ['b']), makeStep('b', ['a'])])
    expect(() => planner.getTopologicalOrder(spec)).toThrow(CyclicDependencyError)
  })
})

describe('ChainPlanner.getReadySteps', () => {
  it('returns all steps with no deps as ready initially', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b'), makeStep('c')])
    const result = planner.getReadySteps(spec, new Map(), new Map())
    expect(result.ready.map(s => s.stepId)).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    expect(result.blocked).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('blocks step whose dep has not completed', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a'])])
    // 'a' is running, 'b' is not submitted
    const jobs = new Map([['a', makeJobRecord('job-a', JobStatus.RUNNING)]])
    const result = planner.getReadySteps(spec, jobs, new Map())
    expect(result.ready.map(s => s.stepId)).toEqual([])
    // 'a' is running so it's blocked (already submitted), 'b' is blocked (dep running)
    expect(result.blocked.map(s => s.stepId)).toEqual(expect.arrayContaining(['b']))
  })

  it('makes a step ready when its dep completes', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a'])])
    const jobs = new Map([['a', makeJobRecord('job-a', JobStatus.COMPLETED)]])
    const result = planner.getReadySteps(spec, jobs, new Map())
    expect(result.ready.map(s => s.stepId)).toEqual(['b'])
    expect(result.completed.map(s => s.stepId)).toEqual(['a'])
  })

  it('identifies completed steps', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a'])])
    const jobs = new Map([
      ['a', makeJobRecord('job-a', JobStatus.COMPLETED)],
      ['b', makeJobRecord('job-b', JobStatus.COMPLETED)],
    ])
    const result = planner.getReadySteps(spec, jobs, new Map())
    expect(result.completed.map(s => s.stepId)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(result.ready).toHaveLength(0)
  })

  it('skips steps when dep fails', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a'])])
    const jobs = new Map([['a', makeJobRecord('job-a', JobStatus.FAILED)]])
    const result = planner.getReadySteps(spec, jobs, new Map())
    expect(result.skipped.map(s => s.stepId)).toEqual(['b'])
    expect(result.failed.map(s => s.stepId)).toEqual(['a'])
  })

  it('skips steps when dep is cancelled', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b', ['a'])])
    const jobs = new Map([['a', makeJobRecord('job-a', JobStatus.CANCELLED)]])
    const result = planner.getReadySteps(spec, jobs, new Map())
    expect(result.skipped.map(s => s.stepId)).toEqual(['b'])
  })

  it('supports parallel steps (multiple with no deps)', () => {
    const spec = makeSpec([makeStep('a'), makeStep('b'), makeStep('c', ['a', 'b'])])
    const result = planner.getReadySteps(spec, new Map(), new Map())
    expect(result.ready.map(s => s.stepId)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(result.blocked.map(s => s.stepId)).toEqual(['c'])
  })

  it('skips step when condition is not met', () => {
    const spec = makeSpec([
      makeStep('a'),
      makeStep('b', ['a'], "metrics.val_acc > 0.9"),
    ])
    const jobA = { ...makeJobRecord('job-a', JobStatus.COMPLETED), metrics: { val_acc: 0.5 } }
    const jobs = new Map([['a', jobA]])
    const analysisResults = new Map<string, AnalysisResult>([
      ['a', { jobId: 'job-a', metrics: { val_acc: 0.5 }, shouldContinueChain: true, summary: '' }]
    ])
    const result = planner.getReadySteps(spec, jobs, analysisResults)
    expect(result.skipped.map(s => s.stepId)).toEqual(['b'])
  })

  it('marks step ready when condition is met', () => {
    const spec = makeSpec([
      makeStep('a'),
      makeStep('b', ['a'], "metrics.val_acc > 0.9"),
    ])
    const jobA = { ...makeJobRecord('job-a', JobStatus.COMPLETED), metrics: { val_acc: 0.95 } }
    const jobs = new Map([['a', jobA]])
    const analysisResults = new Map<string, AnalysisResult>([
      ['a', { jobId: 'job-a', metrics: { val_acc: 0.95 }, shouldContinueChain: true, summary: '' }]
    ])
    const result = planner.getReadySteps(spec, jobs, analysisResults)
    expect(result.ready.map(s => s.stepId)).toEqual(['b'])
  })
})

describe('ChainPlanner.evaluateCondition', () => {
  it('evaluates simple greater-than comparison', () => {
    expect(planner.evaluateCondition('metrics.val_acc > 0.85', { val_acc: 0.9 }, 'completed')).toBe(true)
    expect(planner.evaluateCondition('metrics.val_acc > 0.85', { val_acc: 0.7 }, 'completed')).toBe(false)
  })

  it('evaluates status string comparison', () => {
    expect(planner.evaluateCondition("status == 'completed'", {}, 'completed')).toBe(true)
    expect(planner.evaluateCondition("status == 'completed'", {}, 'failed')).toBe(false)
  })

  it('evaluates && (both true)', () => {
    expect(planner.evaluateCondition(
      'metrics.val_acc > 0.85 && metrics.train_loss < 0.1',
      { val_acc: 0.9, train_loss: 0.05 },
      'completed',
    )).toBe(true)
  })

  it('evaluates && (one false)', () => {
    expect(planner.evaluateCondition(
      'metrics.val_acc > 0.85 && metrics.train_loss < 0.1',
      { val_acc: 0.9, train_loss: 0.5 },
      'completed',
    )).toBe(false)
  })

  it('evaluates || (one true)', () => {
    expect(planner.evaluateCondition(
      'metrics.val_acc > 0.9 || metrics.val_acc > 0.8',
      { val_acc: 0.85 },
      'completed',
    )).toBe(true)
  })

  it('returns false (not throw) when metric is missing', () => {
    // NaN comparisons return false
    expect(planner.evaluateCondition('metrics.val_acc > 0.85', {}, 'completed')).toBe(false)
  })

  it('evaluates cross-step reference via analysisResults', () => {
    const analysisResults = new Map<string, AnalysisResult>([
      ['step1', { jobId: 'j1', metrics: { val_acc: 0.95 }, shouldContinueChain: true, summary: '' }]
    ])
    expect(planner.evaluateCondition(
      'steps.step1.metrics.val_acc > 0.9',
      {},
      'completed',
      analysisResults,
    )).toBe(true)
  })

  it('returns false for cross-step ref when step not found', () => {
    const analysisResults = new Map<string, AnalysisResult>()
    expect(planner.evaluateCondition(
      'steps.unknown.metrics.val_acc > 0.9',
      {},
      'completed',
      analysisResults,
    )).toBe(false)
  })

  it('evaluates >= operator', () => {
    expect(planner.evaluateCondition('metrics.epoch >= 50', { epoch: 50 }, 'completed')).toBe(true)
    expect(planner.evaluateCondition('metrics.epoch >= 50', { epoch: 49 }, 'completed')).toBe(false)
  })

  it('evaluates != operator', () => {
    expect(planner.evaluateCondition("status != 'failed'", {}, 'completed')).toBe(true)
    expect(planner.evaluateCondition("status != 'failed'", {}, 'failed')).toBe(false)
  })
})
