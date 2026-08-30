import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGapId, reduceGapEvents } from '../src/quality-state.mjs'

test('Gap ID is stable across whitespace and punctuation changes', () => {
  assert.equal(
    createGapId('orders', '什么情况下允许退款？', 'bad_rating'),
    createGapId('orders', ' 什么情况下允许退款! ', 'bad_rating'),
  )
  assert.notEqual(
    createGapId('orders', '什么情况下允许退款？', 'bad_rating'),
    createGapId('orders', '什么情况下允许退款？', 'retrieval_miss'),
  )
})

test('Gap reducer preserves close and reopen lifecycle', () => {
  const gap = reduceGapEvents([
    { at: '2026-01-01T00:00:00Z', gap_id: 'gap:orders:a', event: 'opened', module: 'orders', query: '退款', kind: 'bad_rating' },
    { at: '2026-01-02T00:00:00Z', gap_id: 'gap:orders:a', event: 'linked_knowledge', knowledge_id: 'kb:orders:quality:feedback:a' },
    { at: '2026-01-03T00:00:00Z', gap_id: 'gap:orders:a', event: 'linked_eval_case', eval_case_id: 'eval:orders:a' },
    { at: '2026-01-04T00:00:00Z', gap_id: 'gap:orders:a', event: 'closed', evaluation_run_id: 'evalrun_a' },
    { at: '2026-01-05T00:00:00Z', gap_id: 'gap:orders:a', event: 'reopened', evaluation_run_id: 'evalrun_b' },
  ])[0]
  assert.equal(gap.status, 'reopened')
  assert.deepEqual(gap.knowledge_ids, ['kb:orders:quality:feedback:a'])
  assert.deepEqual(gap.eval_case_ids, ['eval:orders:a'])
  assert.equal(gap.occurrences, 1)
})
