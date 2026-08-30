const GRADES = [
  { grade: 'A', min: 0.9 },
  { grade: 'B', min: 0.7 },
  { grade: 'C', min: 0.5 },
  { grade: 'D', min: 0.3 },
  { grade: 'E', min: 0 },
]

const APPLICABLE_SOURCES = new Set(['deterministic', 'history', 'user'])
const CLOSED_GAP_STATUSES = new Set(['filled', 'merged', 'reused', 'closed', 'verified'])

function clampScore(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(1, Math.max(0, number))
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

export function gradeFromScore(score) {
  if (score == null) return 'N_A'
  return GRADES.find(item => score >= item.min)?.grade || 'E'
}

function uniqueById(items) {
  const seen = new Set()
  return (Array.isArray(items) ? items : []).filter(item => {
    if (!item || !item.id || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function isVerifiedCase(item) {
  return item.verified === true || item.status === 'verified'
}

function isClosedGap(item) {
  const evidence = Array.isArray(item.evidence_refs) ? item.evidence_refs : []
  return CLOSED_GAP_STATUSES.has(item.status) && evidence.length > 0
}

export function calculateKnowledgeConfidence({ evidenceScore, expectedCases = [], gaps = [] } = {}) {
  const evidence = clampScore(evidenceScore)
  const uniqueCases = uniqueById(expectedCases)
  const applicableCases = uniqueCases.filter(item => APPLICABLE_SOURCES.has(item.source))
  const candidateCases = uniqueCases.filter(item => !APPLICABLE_SOURCES.has(item.source))
  const verifiedCases = applicableCases.filter(isVerifiedCase)
  const missingCases = applicableCases.filter(item => !isVerifiedCase(item))

  const uniqueGaps = uniqueById(gaps)
  const closedGaps = uniqueGaps.filter(isClosedGap)
  const openGaps = uniqueGaps.filter(item => !isClosedGap(item))

  const scenarioScore = applicableCases.length > 0
    ? round(verifiedCases.length / applicableCases.length)
    : null
  const gapScore = uniqueGaps.length > 0 ? round(closedGaps.length / uniqueGaps.length) : null

  const weighted = []
  if (evidence != null) weighted.push({ score: evidence, weight: 0.5 })
  if (scenarioScore != null) weighted.push({ score: scenarioScore, weight: 0.3 })
  if (gapScore != null) weighted.push({ score: gapScore, weight: 0.2 })
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0)
  const overall = totalWeight > 0
    ? round(weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight)
    : null

  return {
    evidence_confidence: { score: evidence, grade: gradeFromScore(evidence) },
    scenario_coverage: {
      applicable: applicableCases.length,
      verified: verifiedCases.length,
      score: scenarioScore,
      missing_case_ids: missingCases.map(item => item.id),
      candidate_case_ids: candidateCases.map(item => item.id),
    },
    gap_closure: {
      discovered: uniqueGaps.length,
      closed: closedGaps.length,
      score: gapScore,
      open_gap_ids: openGaps.map(item => item.id),
    },
    overall_confidence: {
      score: overall,
      grade: gradeFromScore(overall),
      policy: 'kb-confidence-v2',
    },
  }
}

function branchValues(branches) {
  if (Array.isArray(branches)) return branches
  if (branches && typeof branches === 'object') {
    return Object.entries(branches).map(([value, detail]) => ({ value, detail }))
  }
  return []
}

export function deriveNavigationCases({ branchRoutes = {}, stateMachines = {}, timeoutRecovery = {}, frameworkFacts = {} } = {}) {
  const cases = []
  for (const route of branchRoutes.routes || []) {
    for (const branch of branchValues(route.branches)) {
      const value = branch && typeof branch === 'object' ? branch.value : branch
      if (route.field != null && value != null) {
        cases.push({ id: `branch:${route.field}:${value}`, source: 'deterministic', verified: false })
      }
    }
  }
  for (const machine of stateMachines.machines || []) {
    for (const transition of machine.transitions || []) {
      if (machine.entity && transition.from != null && transition.to != null) {
        cases.push({
          id: `state:${machine.entity}:${transition.from}->${transition.to}`,
          source: 'deterministic',
          verified: false,
        })
      }
    }
  }
  for (const handler of timeoutRecovery.handlers || []) {
    const name = handler?.name || handler?.handler || handler
    if (name) cases.push({ id: `timeout:${name}`, source: 'deterministic', verified: false })
  }
  const factNodes = frameworkFacts?.data?.nodes || []
  const factEdges = frameworkFacts?.data?.edges || []
  const nodesById = new Map(factNodes.map(node => [node.id, node]))
  for (const endpoint of factNodes.filter(node => node.type === 'endpoint' && node.method && node.route)) {
    cases.push({ id: `endpoint:${endpoint.method}:${endpoint.route}`, source: 'deterministic', verified: false })
  }
  for (const edge of factEdges.filter(item => item.type === 'calls-endpoint' && Number(item.confidence || 0) >= 0.9)) {
    const endpoint = nodesById.get(edge.to)
    if (endpoint?.method && endpoint?.route) {
      cases.push({ id: `cross-http:${endpoint.method}:${endpoint.route}`, source: 'deterministic', verified: false })
    }
  }
  return uniqueById(cases)
}
