// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { evaluateCondition, tokenize } from '../src/strategies/conditional.js'
import type { EvalContext } from '../src/strategies/conditional.js'
import { ConditionParseError } from '../src/core/errors.js'

function ctx(
  metrics: Record<string, number> = {},
  status = 'completed',
  stepMetrics?: Map<string, Record<string, number>>,
): EvalContext {
  return { metrics, status, stepMetrics }
}

describe('tokenize', () => {
  it('tokenizes a simple comparison', () => {
    const tokens = tokenize("metrics.val_acc > 0.85")
    expect(tokens).toHaveLength(3)
    expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'metrics.val_acc' })
    expect(tokens[1]).toMatchObject({ type: 'OP', value: '>' })
    expect(tokens[2]).toMatchObject({ type: 'NUMBER', value: '0.85' })
  })

  it('tokenizes status == string literal', () => {
    const tokens = tokenize("status == 'completed'")
    expect(tokens[0]).toMatchObject({ type: 'IDENT', value: 'status' })
    expect(tokens[1]).toMatchObject({ type: 'OP', value: '==' })
    expect(tokens[2]).toMatchObject({ type: 'STRING', value: 'completed' })
  })

  it('tokenizes && and || operators', () => {
    const tokens = tokenize("metrics.a > 0.5 && metrics.b < 0.1")
    const logicTokens = tokens.filter(t => t.type === 'LOGIC')
    expect(logicTokens).toHaveLength(1)
    expect(logicTokens[0]).toMatchObject({ value: '&&' })
  })

  it('tokenizes two-char ops: >=, <=, ==, !=', () => {
    for (const op of ['>=', '<=', '==', '!=']) {
      const tokens = tokenize(`metrics.x ${op} 1`)
      const opToken = tokens.find(t => t.type === 'OP')
      expect(opToken?.value).toBe(op)
    }
  })

  it('handles negative numbers', () => {
    const tokens = tokenize('metrics.loss > -0.5')
    const num = tokens.find(t => t.type === 'NUMBER')
    expect(num?.value).toBe('-0.5')
  })
})

describe('evaluateCondition - simple comparisons', () => {
  it('metrics.val_acc > 0.85 — true', () => {
    expect(evaluateCondition('metrics.val_acc > 0.85', ctx({ val_acc: 0.9 }))).toBe(true)
  })

  it('metrics.val_acc > 0.85 — false', () => {
    expect(evaluateCondition('metrics.val_acc > 0.85', ctx({ val_acc: 0.7 }))).toBe(false)
  })

  it('metrics.val_acc < 0.5 — true', () => {
    expect(evaluateCondition('metrics.val_acc < 0.5', ctx({ val_acc: 0.1 }))).toBe(true)
  })

  it("status == 'completed' — true", () => {
    expect(evaluateCondition("status == 'completed'", ctx({}, 'completed'))).toBe(true)
  })

  it("status == 'completed' — false", () => {
    expect(evaluateCondition("status == 'completed'", ctx({}, 'failed'))).toBe(false)
  })

  it("status != 'failed' — true", () => {
    expect(evaluateCondition("status != 'failed'", ctx({}, 'completed'))).toBe(true)
  })

  it('metrics.epoch >= 100 — true at boundary', () => {
    expect(evaluateCondition('metrics.epoch >= 100', ctx({ epoch: 100 }))).toBe(true)
  })

  it('metrics.epoch <= 50 — false when epoch > 50', () => {
    expect(evaluateCondition('metrics.epoch <= 50', ctx({ epoch: 51 }))).toBe(false)
  })
})

describe('evaluateCondition - logical operators', () => {
  it('&& both true → true', () => {
    expect(evaluateCondition(
      'metrics.val_acc > 0.85 && metrics.train_loss < 0.1',
      ctx({ val_acc: 0.9, train_loss: 0.05 }),
    )).toBe(true)
  })

  it('&& first false → false', () => {
    expect(evaluateCondition(
      'metrics.val_acc > 0.85 && metrics.train_loss < 0.1',
      ctx({ val_acc: 0.7, train_loss: 0.05 }),
    )).toBe(false)
  })

  it('&& second false → false', () => {
    expect(evaluateCondition(
      'metrics.val_acc > 0.85 && metrics.train_loss < 0.1',
      ctx({ val_acc: 0.9, train_loss: 0.5 }),
    )).toBe(false)
  })

  it('|| one true → true', () => {
    expect(evaluateCondition(
      'metrics.val_acc > 0.95 || metrics.val_acc > 0.80',
      ctx({ val_acc: 0.85 }),
    )).toBe(true)
  })

  it('|| both false → false', () => {
    expect(evaluateCondition(
      'metrics.val_acc > 0.95 || metrics.val_acc > 0.90',
      ctx({ val_acc: 0.85 }),
    )).toBe(false)
  })

  it('chained && evaluates left to right', () => {
    expect(evaluateCondition(
      'metrics.a > 0 && metrics.b > 0 && metrics.c > 0',
      ctx({ a: 1, b: 2, c: 3 }),
    )).toBe(true)

    expect(evaluateCondition(
      'metrics.a > 0 && metrics.b > 0 && metrics.c > 0',
      ctx({ a: 1, b: 0, c: 3 }),
    )).toBe(false)
  })
})

describe('evaluateCondition - cross-step references', () => {
  it('steps.step1.metrics.val_acc > 0.9 — true', () => {
    const stepMetrics = new Map([['step1', { val_acc: 0.95 }]])
    expect(evaluateCondition(
      'steps.step1.metrics.val_acc > 0.9',
      ctx({}, 'completed', stepMetrics),
    )).toBe(true)
  })

  it('steps.step1.metrics.val_acc > 0.9 — false', () => {
    const stepMetrics = new Map([['step1', { val_acc: 0.85 }]])
    expect(evaluateCondition(
      'steps.step1.metrics.val_acc > 0.9',
      ctx({}, 'completed', stepMetrics),
    )).toBe(false)
  })

  it('unknown step returns NaN → comparison is false', () => {
    const stepMetrics = new Map<string, Record<string, number>>()
    expect(evaluateCondition(
      'steps.missing.metrics.val_acc > 0.9',
      ctx({}, 'completed', stepMetrics),
    )).toBe(false)
  })
})

describe('evaluateCondition - edge cases', () => {
  it('missing metric returns NaN → numeric comparison is false', () => {
    expect(evaluateCondition('metrics.val_acc > 0.85', ctx({}))).toBe(false)
  })

  it('missing metric with || fallback still evaluates correctly', () => {
    // First term NaN (false), second term is true
    expect(evaluateCondition(
      'metrics.missing > 0.5 || metrics.present > 0.5',
      ctx({ present: 0.9 }),
    )).toBe(true)
  })

  it('throws ConditionParseError on unknown identifier', () => {
    expect(() => evaluateCondition('unknown_var > 0.5', ctx({}))).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError on empty expression', () => {
    expect(() => evaluateCondition('', ctx({}))).toThrow()
  })

  it('exact equality of numbers', () => {
    expect(evaluateCondition('metrics.epoch == 50', ctx({ epoch: 50 }))).toBe(true)
    expect(evaluateCondition('metrics.epoch == 50', ctx({ epoch: 51 }))).toBe(false)
  })
})
