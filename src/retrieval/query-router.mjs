const LINEAGE = /字段.{0,24}(?:来源|血缘|接口|影响|消费|加工)|(?:后端|接口).{0,16}字段.{0,16}(?:页面|前端|影响)/
const IMPACT = /影响(?:面|范围|哪些|什么)|改(?:动|了|这个|某个).{0,24}(?:影响|页面|功能|模块)|哪些.{0,16}(?:调用方|依赖方|页面)/
const CHAIN = /调用链|链路|经过哪些|从.{0,20}(?:到|经过).{0,20}(?:接口|函数|组件|代码)|如何实现|怎么实现/
const STATE = /状态(?:机|流转|路径|变化)|从.{0,16}状态.{0,16}到|超时.{0,12}(?:恢复|重试)/
const BUSINESS = /业务|规则|条件|什么时候|什么情况下|为什么|用户|产品|限制|缺陷|事故|决策/

const EDGE_POLICIES = {
  semantic: null,
  impact: new Set(['calls', 'calls-api', 'calls-endpoint', 'implemented-by', 'imports', 'depends-on', 'depends_on', 'uses', 'renders-component', 'renders-route', 'triggers', 'reads', 'writes', 'provides-field', 'renders-field', 'contains-field', 'contains', 'declares', 'declares-page', 'tested_by']),
  chain: new Set(['binds-event', 'triggers', 'calls', 'calls-api', 'calls-endpoint', 'implemented-by', 'depends-on', 'depends_on', 'uses', 'renders-component', 'subscribes', 'emits', 'declares', 'declares-page', 'evidence-at']),
  lineage: new Set(['calls-api', 'calls-endpoint', 'implemented-by', 'provides-field', 'renders-field', 'contains-field', 'binds-model', 'accepts-prop', 'transforms-with', 'visible-when', 'abnormal-when', 'reads', 'writes', 'transforms', 'evidence-at']),
  state: new Set(['owns-state', 'transitions', 'recovers-with', 'recovers_with', 'visible-when', 'abnormal-when', 'calls', 'triggers', 'has-evidence', 'evidence-at']),
  hybrid: null,
}

export function routeQuery(query, options = {}) {
  const text = String(query || '').trim()
  let intent = 'semantic'
  if (LINEAGE.test(text)) intent = 'lineage'
  else if (IMPACT.test(text)) intent = 'impact'
  else if (CHAIN.test(text)) intent = 'chain'
  else if (STATE.test(text)) intent = 'state'
  const hybrid = intent !== 'semantic' && BUSINESS.test(text)
  if (hybrid) intent = 'hybrid'
  const route = intent === 'semantic' ? 'document-first' : intent === 'hybrid' ? 'document-graph' : 'graph-first'
  return {
    intent,
    route,
    detail: options.detail || (intent === 'semantic' ? 'semantic' : 'evidence'),
    maxDepth: intent === 'semantic' ? 2 : 3,
    edgeTypes: EDGE_POLICIES[intent],
  }
}

export function edgeAllowed(route, edge) {
  return !route?.edgeTypes || route.edgeTypes.has(edge?.type)
}
