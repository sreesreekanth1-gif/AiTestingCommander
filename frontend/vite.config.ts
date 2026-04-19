import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { writeFile, readFile, stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

interface Payload {
  type?: 'AI' | 'ALM'
  baseUrl?: string
  username?: string
  token?: string
  selectedTool?: string
  issueId?: string
  llmProvider?: string
  llmEndpoint?: string
  llmModel?: string
  llmApiKey?: string
}

const readJsonBody = (req: any): Promise<any> =>
  new Promise((resolve, reject) => {
    let raw = ''

    req.on('data', (chunk: any) => {
      raw += chunk
    })

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })

const sendJson = (res: any, status: number, payload: any) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

const normalizeModelName = (value: string | undefined) => (value || '').trim().toLowerCase()

const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 20000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal as AbortSignal,
    })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const extractText = (value: any): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ').trim()
  if (typeof value === 'object') {
    const parts: string[] = []
    if (value.text) parts.push(String(value.text))
    if (value.content) parts.push(extractText(value.content))
    if (value.items) parts.push(extractText(value.items))
    return parts.filter(Boolean).join(' ').trim()
  }
  return String(value)
}

const fetchWithShortTimeout = (url: string, options: RequestInit) => fetchWithTimeout(url, options, 20000)

const requireFields = (payload: any, fields: string[], toolName: string) => {
  const missing = fields.filter((f) => !(payload[f] || '').trim())
  if (missing.length) throw new Error(`${toolName}: ${missing.join(', ')} are required for gap analysis.`)
}

const fetchJiraIssueContext = async (payload: Payload): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '')
  const issueId = (payload.issueId || '').trim()
  requireFields(payload, ['baseUrl', 'username', 'token', 'issueId'], 'Jira')

  const auth = Buffer.from(`${payload.username}:${payload.token}`).toString('base64')
  const url = `${normalized}/rest/api/3/issue/${issueId}?fields=summary,description,issuetype,priority,labels,components`
  const response = await fetchWithShortTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  })

  if (response.status === 401 || response.status === 403) throw new Error('Jira authentication failed for gap analysis.')
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Jira issue fetch failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const data = await response.json()
  const fields = data.fields || {}
  const components = Array.isArray(fields.components)
    ? fields.components.map((c: any) => c?.name).filter(Boolean).join(', ')
    : ''
  const labels = Array.isArray(fields.labels) ? fields.labels.join(', ') : ''

  return [
    `Issue ID: ${issueId}`,
    `Issue Type: ${extractText(fields.issuetype?.name)}`,
    `Priority: ${extractText(fields.priority?.name)}`,
    `Labels: ${labels}`,
    `Components: ${components}`,
    `Title: ${extractText(fields.summary)}`,
    `Description: ${extractText(fields.description)}`,
  ].join('\n').trim()
}

const fetchADOIssueContext = async (payload: Payload): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '')
  const issueId = (payload.issueId || '').trim()
  requireFields(payload, ['baseUrl', 'token', 'issueId'], 'ADO')

  const auth = Buffer.from(`:${payload.token}`).toString('base64')
  const url = `${normalized}/_apis/wit/workitems/${issueId}?$expand=all&api-version=7.1`
  const response = await fetchWithShortTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  })

  if (response.status === 401 || response.status === 403) throw new Error('ADO authentication failed for gap analysis.')
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ADO work item fetch failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const data = await response.json()
  const f = data.fields || {}
  const tags = (f['System.Tags'] || '').split(';').map((t: string) => t.trim()).filter(Boolean).join(', ')

  return [
    `Work Item ID: ${issueId}`,
    `Type: ${f['System.WorkItemType'] || ''}`,
    `State: ${f['System.State'] || ''}`,
    `Priority: ${f['Microsoft.VSTS.Common.Priority'] || ''}`,
    `Tags: ${tags}`,
    `Title: ${extractText(f['System.Title'])}`,
    `Description: ${extractText(f['System.Description'])}`,
    `Acceptance Criteria: ${extractText(f['Microsoft.VSTS.Common.AcceptanceCriteria'])}`,
  ].join('\n').trim()
}

const fetchTestRailContext = async (payload: Payload): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '')
  const issueId = (payload.issueId || '').trim()
  requireFields(payload, ['baseUrl', 'username', 'token', 'issueId'], 'TestRail')

  const auth = Buffer.from(`${payload.username}:${payload.token}`).toString('base64')
  const url = `${normalized}/index.php?/api/v2/get_case/${issueId}`
  const response = await fetchWithShortTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  })

  if (response.status === 401 || response.status === 403) throw new Error('TestRail authentication failed for gap analysis.')
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`TestRail case fetch failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const data = await response.json()

  return [
    `Case ID: ${issueId}`,
    `Title: ${extractText(data.title)}`,
    `References: ${data.refs || ''}`,
    `Preconditions: ${extractText(data.custom_preconds)}`,
    `Steps: ${extractText(data.custom_steps)}`,
    `Expected Result: ${extractText(data.custom_expected)}`,
  ].join('\n').trim()
}

const fetchQTestContext = async (payload: Payload): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '')
  const issueId = (payload.issueId || '').trim()
  requireFields(payload, ['baseUrl', 'token', 'issueId'], 'QTest')

  const parts = issueId.split('/')
  let url
  if (parts.length === 2) {
    const [projectId, reqId] = parts
    url = `${normalized}/api/v3/projects/${projectId}/requirements/${reqId}`
  } else {
    url = `${normalized}/api/v3/requirements/${issueId}`
  }

  const response = await fetchWithShortTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${payload.token}` },
  })

  if (response.status === 401 || response.status === 403) throw new Error('QTest authentication failed for gap analysis.')
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`QTest requirement fetch failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const data = await response.json()
  const props = Array.isArray(data.properties)
    ? data.properties.map((p: any) => `${p.field_name}: ${extractText(p.field_value)}`).join('\n')
    : ''

  return [
    `Requirement ID: ${issueId}`,
    `Name: ${extractText(data.name)}`,
    `Description: ${extractText(data.description)}`,
    props,
  ].filter(Boolean).join('\n').trim()
}

const fetchIssueContext = (payload: Payload): Promise<string> => {
  switch (payload.selectedTool) {
    case 'Jira':     return fetchJiraIssueContext(payload)
    case 'ADO':      return fetchADOIssueContext(payload)
    case 'TestRail': return fetchTestRailContext(payload)
    case 'QTest':    return fetchQTestContext(payload)
    default:         throw new Error(`Gap analysis is not supported for tool: ${payload.selectedTool}`)
  }
}

const parseIssueDetails = (raw: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(': ')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      result[key] = line.slice(idx + 2).trim()
    }
  }
  return result
}

const buildGapPrompt = (issueId: string, contextText: string): string =>
  `You are a QA requirements gap analyst.
Review the requirement below and identify testing-relevant gaps only from the provided content.
Do not invent missing facts as if they are present.
Return valid JSON exactly in this shape:
{
  "issueId": "${issueId}",
  "summary": "short summary",
  "sourceContext": "brief excerpt or condensed context",
  "strengths": ["item 1", "item 2"],
  "gaps": ["item 1", "item 2"],
  "recommendation": "one concise recommendation"
}

Requirement context:
${contextText}`

const parseGapAnalysis = (analysis: any, issueId: string, contextText: string) => ({
  issueId: analysis.issueId || issueId,
  summary: analysis.summary || `Gap review completed for ${issueId}.`,
  sourceContext: analysis.sourceContext || contextText.slice(0, 1200),
  strengths: Array.isArray(analysis.strengths) ? analysis.strengths : [],
  gaps: Array.isArray(analysis.gaps) ? analysis.gaps : [],
  recommendation: analysis.recommendation || 'Clarify the missing items before generating the final test plan.',
})

const checkOllamaLive = async (endpoint: string, model: string) => {
  let res: Response
  try {
    res = await fetchWithTimeout(`${endpoint}/api/tags`, {}, 8000)
  } catch {
    throw new Error(`Ollama is not reachable at ${endpoint}. Make sure it is running.`)
  }
  if (!res.ok) throw new Error(`Ollama endpoint returned ${res.status}. Make sure it is running.`)
  const data = await res.json()
  const available = Array.isArray(data.models)
    ? data.models.map((m: any) => normalizeModelName(m.name || m.model)).filter(Boolean)
    : []
  if (!available.includes(normalizeModelName(model))) {
    throw new Error(`Model '${model}' was not found on the Ollama endpoint.`)
  }
}

const checkHostedProviderLive = async (provider: string, apiKey: string, apiUrl: string, headersBuilder: (key: string) => any) => {
  let res: Response
  try {
    res = await fetchWithTimeout(apiUrl, { method: 'GET', headers: headersBuilder(apiKey) }, 8000)
  } catch {
    throw new Error(`${provider} API is not reachable. Check your network connection.`)
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Invalid ${provider} API key.`)
  if (!res.ok) throw new Error(`${provider} API returned ${res.status}. The service may be unavailable.`)
}

const analyzeWithOllama = async (payload: Payload, contextText: string) => {
  const endpoint = (payload.llmEndpoint || '').trim().replace(/\/+$/, '')
  const model = (payload.llmModel || '').trim()
  const issueId = (payload.issueId || 'UNKNOWN').trim()

  if (!endpoint) throw new Error('Missing Ollama endpoint.')
  if (!model) throw new Error('Missing Model Name.')

  await checkOllamaLive(endpoint, model)

  const response = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: buildGapPrompt(issueId, contextText),
      stream: false,
      format: 'json',
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama analysis failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const result = await response.json()
  const raw = (result.response || '').trim()
  if (!raw) throw new Error('Ollama returned an empty gap analysis response.')

  return parseGapAnalysis(JSON.parse(raw), issueId, contextText)
}

const analyzeWithAnthropic = async (payload: Payload, contextText: string) => {
  const apiKey = (payload.llmApiKey || '').trim()
  const model = (payload.llmModel || '').trim()
  const issueId = (payload.issueId || 'UNKNOWN').trim()

  if (!apiKey) throw new Error('Missing Anthropic API key.')
  if (!model) throw new Error('Missing Model Name.')

  await checkHostedProviderLive('Anthropic', apiKey, 'https://api.anthropic.com/v1/models', (key) => ({
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    Accept: 'application/json',
  }))

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildGapPrompt(issueId, contextText) }],
    }),
  })

  if (response.status === 401 || response.status === 403) throw new Error('Invalid Anthropic API key.')
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Anthropic analysis failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const result = await response.json()
  const raw = result.content?.[0]?.text?.trim()
  if (!raw) throw new Error('Anthropic returned an empty gap analysis response.')

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Anthropic response did not contain valid JSON.')

  return parseGapAnalysis(JSON.parse(jsonMatch[0]), issueId, contextText)
}

const analyzeWithOpenAICompatible = async (payload: Payload, contextText: string, providerName: string, apiUrl: string) => {
  const apiKey = (payload.llmApiKey || '').trim()
  const model = (payload.llmModel || '').trim()
  const issueId = (payload.issueId || 'UNKNOWN').trim()

  if (!apiKey) throw new Error(`Missing ${providerName} API key.`)
  if (!model) throw new Error('Missing Model Name.')

  await checkHostedProviderLive(providerName, apiKey, `${apiUrl}/models`, (key) => ({
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }))

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildGapPrompt(issueId, contextText) }],
      response_format: { type: 'json_object' },
    }),
  })

  if (response.status === 401 || response.status === 403) throw new Error(`Invalid ${providerName} API key.`)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${providerName} analysis failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const result = await response.json()
  const raw = result.choices?.[0]?.message?.content?.trim()
  if (!raw) throw new Error(`${providerName} returned an empty gap analysis response.`)

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`${providerName} response did not contain valid JSON.`)

  return parseGapAnalysis(JSON.parse(jsonMatch[0]), issueId, contextText)
}

const analyzeGaps = (payload: Payload, contextText: string) => {
  switch (payload.llmProvider) {
    case 'Ollama':
      return analyzeWithOllama(payload, contextText)
    case 'Anthropic':
    case 'Claude':
      return analyzeWithAnthropic(payload, contextText)
    case 'GROQ':
      return analyzeWithOpenAICompatible(payload, contextText, 'GROQ', 'https://api.groq.com/openai/v1')
    case 'Grok':
      return analyzeWithOpenAICompatible(payload, contextText, 'Grok', 'https://api.x.ai/v1')
    case 'OpenRouter':
      return analyzeWithOpenAICompatible(payload, contextText, 'OpenRouter', 'https://openrouter.ai/api/v1')
    default:
      throw new Error(`Gap analysis is not supported for provider: ${payload.llmProvider}`)
  }
}

/* ── Coverage analysis (Review Test Cases) ─────────────────────────────── */

const buildCoveragePrompt = (requirementContext: string, testCasesJson: string): string =>
  `You are a QA coverage analyst. Compare the requirement below against the provided test cases.
Determine what percentage of the requirement is covered by the test cases.
Return valid JSON exactly in this shape:
{
  "coveragePercent": <number 0-100>,
  "summary": "brief coverage summary",
  "coveredAreas": ["area 1", "area 2"],
  "uncoveredGaps": ["gap 1", "gap 2"],
  "recommendations": ["rec 1", "rec 2"]
}

Requirement:
${requirementContext}

Test Cases:
${testCasesJson}`

const parseCoverageResult = (raw: any) => ({
  coveragePercent: typeof raw.coveragePercent === 'number' ? Math.max(0, Math.min(100, Math.round(raw.coveragePercent))) : 0,
  summary: raw.summary || 'Coverage analysis completed.',
  coveredAreas: Array.isArray(raw.coveredAreas) ? raw.coveredAreas : [],
  uncoveredGaps: Array.isArray(raw.uncoveredGaps) ? raw.uncoveredGaps : [],
  recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
})

const callLlmWithPrompt = async (payload: Payload, prompt: string): Promise<any> => {
  switch (payload.llmProvider) {
    case 'Ollama': {
      const endpoint = (payload.llmEndpoint || '').trim().replace(/\/+$/, '')
      const model = (payload.llmModel || '').trim()
      if (!endpoint) throw new Error('Missing Ollama endpoint.')
      if (!model) throw new Error('Missing Model Name.')
      await checkOllamaLive(endpoint, model)
      const response = await fetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
      })
      if (!response.ok) throw new Error(`Ollama failed with status ${response.status}`)
      const result = await response.json()
      const raw = (result.response || '').trim()
      if (!raw) throw new Error('Ollama returned an empty response.')
      return JSON.parse(raw)
    }
    case 'Anthropic':
    case 'Claude': {
      const apiKey = (payload.llmApiKey || '').trim()
      const model = (payload.llmModel || '').trim()
      if (!apiKey) throw new Error('Missing Anthropic API key.')
      if (!model) throw new Error('Missing Model Name.')
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!response.ok) throw new Error(`Anthropic failed with status ${response.status}`)
      const result = await response.json()
      const raw = result.content?.[0]?.text?.trim()
      if (!raw) throw new Error('Anthropic returned an empty response.')
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('Response did not contain valid JSON.')
      return JSON.parse(jsonMatch[0])
    }
    case 'GROQ':
    case 'Grok':
    case 'OpenRouter': {
      const apiKey = (payload.llmApiKey || '').trim()
      const model = (payload.llmModel || '').trim()
      const apiUrl = payload.llmProvider === 'GROQ'
        ? 'https://api.groq.com/openai/v1'
        : payload.llmProvider === 'Grok'
          ? 'https://api.x.ai/v1'
          : 'https://openrouter.ai/api/v1'
      if (!apiKey) throw new Error(`Missing ${payload.llmProvider} API key.`)
      if (!model) throw new Error('Missing Model Name.')
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'TestPulse AI-OTSI',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      })
      if (!response.ok) throw new Error(`${payload.llmProvider} failed with status ${response.status}`)
      const result = await response.json()
      const raw = result.choices?.[0]?.message?.content?.trim()
      if (!raw) throw new Error(`${payload.llmProvider} returned an empty response.`)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('Response did not contain valid JSON.')
      return JSON.parse(jsonMatch[0])
    }
    default:
      throw new Error(`Coverage analysis is not supported for provider: ${payload.llmProvider}`)
  }
}

const verifyHostedProvider = async (payload: Payload) => {
  const provider = payload.llmProvider
  const apiKey = (payload.llmApiKey || '').trim()
  const requestedModel = normalizeModelName(payload.llmModel)

  if (!apiKey) throw new Error('Missing API Key.')
  if (!requestedModel) throw new Error('Missing Model Name.')

  let url = ''
  let headers: Record<string, string> = {}
  let extractModels = (data: any): string[] => []

  if (provider === 'Anthropic' || provider === 'Claude') {
    url = 'https://api.anthropic.com/v1/models'
    headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    }
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : []
  } else if (provider === 'GROQ') {
    url = 'https://api.groq.com/openai/v1/models'
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : []
  } else if (provider === 'Grok') {
    url = 'https://api.x.ai/v1/models'
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : []
  } else if (provider === 'OpenRouter') {
    url = 'https://openrouter.ai/api/v1/models'
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : []
  } else {
    throw new Error(`Unsupported AI provider: ${provider}`)
  }

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers,
  }, 20000)

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Invalid ${provider} API key.`)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${provider} verification failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }

  const data = await response.json()
  const availableModels = extractModels(data)
  const requested = requestedModel

  if (!availableModels.length) {
    throw new Error(`Unable to load ${provider} models for verification.`)
  }

  if (!availableModels.includes(requested)) {
    const similar = availableModels.filter((m: string) => m.includes(requested))
    const suggestionHeader = similar.length ? 'Top suggestions' : 'Available samples'
    const listToShow = similar.length ? similar.slice(0, 15) : availableModels.slice(0, 15)
    const suggestionStr = listToShow.join(', ')

    throw new Error(
      `Model '${payload.llmModel}' not found for ${provider}. ` +
      `${suggestionHeader}: ${suggestionStr} (Total: ${availableModels.length})`
    )
  }
}

const buildAlmRequest = (payload: Payload) => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  let url = normalized

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Invalid Base URL format')
  }

  if (payload.selectedTool === 'Jira') {
    url = `${normalized}/rest/api/3/myself`
    headers.Authorization = `Basic ${Buffer.from(`${payload.username}:${payload.token}`).toString('base64')}`
  } else if (payload.selectedTool === 'ADO') {
    url = `${normalized}/_apis/projects?api-version=7.1`
    headers.Authorization = `Basic ${Buffer.from(`:${payload.token}`).toString('base64')}`
  } else if (payload.selectedTool === 'TestRail') {
    url = `${normalized}/index.php?/api/v2/get_case_fields`
    headers.Authorization = `Basic ${Buffer.from(`${payload.username}:${payload.token}`).toString('base64')}`
  } else if (payload.selectedTool === 'QTest') {
    url = `${normalized}/api/v3/projects`
    headers.Authorization = `Bearer ${payload.token}`
  } else {
    throw new Error(`${payload.selectedTool} verification is not implemented yet`)
  }

  return { url, headers }
}

const verifyConnectionPlugin = () => ({
  name: 'verify-connection-plugin',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/api/verify', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') {
        next()
        return
      }

      try {
        const payload = await readJsonBody(req) as Payload

        if (payload.type === 'ALM') {
          if (!payload.baseUrl || (!payload.token && payload.selectedTool !== 'X-Ray')) {
             sendJson(res, 400, { detail: 'Missing ALM Credentials' })
             return
          }

          const { url, headers } = buildAlmRequest(payload)
          const response = await fetch(url, {
            method: 'GET',
            headers,
            redirect: 'manual',
          })

          const contentType = response.headers.get('content-type') || ''
          const text = await response.text()

          if ([401, 403].includes(response.status)) {
            sendJson(res, 401, { detail: 'Invalid User or Token Auth' })
            return
          }

          if ([301, 302, 303, 307, 308].includes(response.status)) {
            sendJson(res, 400, { detail: 'Platform redirected the request. Check the workspace URL and API path.' })
            return
          }

          if (response.status === 404) {
            sendJson(res, 404, { detail: `Platform API endpoint not found at ${url}` })
            return
          }

          if (contentType.includes('text/html')) {
            sendJson(res, 401, { detail: 'Authentication Rejected (Received login webpage)' })
            return
          }

          if (!response.ok) {
            sendJson(res, 400, { detail: text || `Platform validation failed with status ${response.status}` })
            return
          }

          sendJson(res, 200, { status: 'success', message: 'Connection Validated' })
          return
        }

        if (payload.type === 'AI') {
          const modelName = normalizeModelName(payload.llmModel)
          if (!modelName) {
            sendJson(res, 400, { detail: 'Missing Model Name' })
            return
          }

          if (payload.llmProvider === 'Ollama') {
            const endpoint = (payload.llmEndpoint || '').trim().replace(/\/+$/, '')
            if (!endpoint) {
              sendJson(res, 400, { detail: 'Missing Endpoint' })
              return
            }

            const response = await fetch(`${endpoint}/api/tags`)
            if (!response.ok) {
              sendJson(res, 400, { detail: `Ollama endpoint returned ${response.status}` })
              return
            }

            const data = await response.json()
            const availableModels = Array.isArray(data.models)
              ? data.models
                  .map((model: any) => normalizeModelName(model.name || model.model))
                  .filter(Boolean)
              : []

            if (!availableModels.includes(modelName)) {
              sendJson(res, 400, { detail: `Model '${payload.llmModel}' was not found on the Ollama endpoint.` })
              return
            }

            sendJson(res, 200, { status: 'success', message: 'Connection Validated' })
            return
          }

          await verifyHostedProvider(payload)
          sendJson(res, 200, { status: 'success', message: 'Connection Validated' })
          return
        }

        sendJson(res, 400, { detail: 'Unsupported verification type' })
      } catch (error: any) {
        sendJson(res, 502, { detail: error?.message || 'Verification request failed' })
      }
    })

    // ── /api/fetch-ticket (fetch issue details without LLM analysis) ──
    server.middlewares.use('/api/fetch-ticket', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') {
        next()
        return
      }

      try {
        const payload = await readJsonBody(req) as Payload
        const contextText = await fetchIssueContext(payload)
        const issueId = (payload.issueId || '').trim()
        const details = parseIssueDetails(contextText)

        sendJson(res, 200, { status: 'success', ticketContext: contextText, issueId, details })
      } catch (error: any) {
        sendJson(res, 400, { detail: error?.message || 'Failed to fetch ticket' })
      }
    })

    server.middlewares.use('/api/analyze-gaps', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') {
        next()
        return
      }

      try {
        const payload = await readJsonBody(req) as Payload

        const contextText = await fetchIssueContext(payload)
        const analysis = await analyzeGaps(payload, contextText)

        sendJson(res, 200, { status: 'success', analysis })
      } catch (error: any) {
        sendJson(res, 400, { detail: error?.message || 'Gap analysis failed' })
      }
    })

    // ── /api/analyze-coverage (Review Test Cases) ──────────────
    server.middlewares.use('/api/analyze-coverage', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') { next(); return }

      try {
        const payload = await readJsonBody(req)
        const { requirementContext, testCases } = payload

        if (!requirementContext?.trim()) {
          sendJson(res, 400, { detail: 'No requirement context provided.' })
          return
        }
        if (!Array.isArray(testCases) || testCases.length === 0) {
          sendJson(res, 400, { detail: 'No test cases to compare against.' })
          return
        }

        const tcSummary = testCases.map((tc: any) => ({
          id: tc.testCaseId,
          title: tc.testCaseTitle,
          module: tc.module,
          steps: tc.testSteps,
          expected: tc.expectedResult,
        }))

        const prompt = buildCoveragePrompt(requirementContext, JSON.stringify(tcSummary, null, 2))
        const rawResult = await callLlmWithPrompt(payload, prompt)
        const coverage = parseCoverageResult(rawResult)

        sendJson(res, 200, { status: 'success', coverage })
      } catch (error: any) {
        sendJson(res, 400, { detail: error?.message || 'Coverage analysis failed' })
      }
    })

    // ── Python engine runner ──────────────────────────────────
    const projectRoot = path.resolve(__dirname, '..')
    const toolsDir = path.join(projectRoot, 'tools')
    const tmpDir = path.join(projectRoot, '.tmp')
    const venvPython = process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python')

    const runPythonEngine = (scriptCode: string, payloadPath: string): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(venvPython, ['-c', scriptCode, payloadPath], {
          cwd: toolsDir,
          timeout: 120_000,
          env: { ...process.env, PYTHONPATH: toolsDir },
        }, (error, stdout, stderr) => {
          if (error) {
            const msg = stderr?.trim() || error.message
            reject(new Error(msg))
          } else {
            resolve(stdout.trim())
          }
        })
      })

    // ── /api/generate-test-cases (must be before /api/generate due to prefix matching) ──
    server.middlewares.use('/api/generate-test-cases', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') { next(); return }

      try {
        const payload = await readJsonBody(req)
        await mkdir(tmpDir, { recursive: true })
        const payloadPath = path.join(tmpDir, 'tc_payload.json')
        await writeFile(payloadPath, JSON.stringify(payload), 'utf-8')

        const script = `
import sys, json
from test_cases_engine import TestCasesEngine
try:
    engine = TestCasesEngine(sys.argv[1])
    doc_path, md_path, test_cases = engine.run_pipeline()
    print(json.dumps({"status":"success","message":"Test cases generated.","document_path":doc_path,"md_path":md_path,"test_cases":test_cases}))
except Exception as e:
    import traceback
    print(json.dumps({"status":"error","detail":str(e),"trace":traceback.format_exc()}))
`
        const raw = await runPythonEngine(script, payloadPath)
        const lines = raw.split('\n').filter(l => l.trim().startsWith('{'))
        const jsonLine = lines.length > 0 ? lines[lines.length - 1] : null

        if (!jsonLine) {
          sendJson(res, 500, { detail: `No valid JSON in Python output: ${raw.slice(0, 500)}` })
          return
        }

        let result
        try {
          result = JSON.parse(jsonLine)
        } catch (parseErr: any) {
          sendJson(res, 500, { detail: `Failed to parse Python output: ${parseErr.message}` })
          return
        }

        if (result.status === 'error') {
          sendJson(res, 500, { detail: result.detail || 'Unknown error in test case generation' })
          return
        }

        sendJson(res, 200, result)
      } catch (error: any) {
        sendJson(res, 500, { detail: error?.message || 'Test case generation failed' })
      }
    })

    // ── /api/generate (Test Plan) ─────────────────────────────
    server.middlewares.use('/api/generate', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') { next(); return }

      try {
        const payload = await readJsonBody(req)
        await mkdir(tmpDir, { recursive: true })
        const payloadPath = path.join(tmpDir, 'job_payload.json')
        await writeFile(payloadPath, JSON.stringify(payload), 'utf-8')

        const script = `
import sys, json
from test_planner_engine import TestPlannerEngine
engine = TestPlannerEngine(sys.argv[1])
doc_path = engine.run_pipeline()
print(json.dumps({"status":"success","message":"Test plan generated.","document_path":doc_path}))
`
        const raw = await runPythonEngine(script, payloadPath)
        const result = JSON.parse(raw.split('\n').filter(l => l.startsWith('{')).pop() || '{}')
        sendJson(res, 200, result)
      } catch (error: any) {
        sendJson(res, 500, { detail: error?.message || 'Test plan generation failed' })
      }
    })

    // ── /api/generate-scenarios ───────────────────────────────
    server.middlewares.use('/api/generate-scenarios', async (req: any, res: any, next: any) => {
      if (req.method !== 'POST') { next(); return }

      try {
        const payload = await readJsonBody(req)
        await mkdir(tmpDir, { recursive: true })
        const payloadPath = path.join(tmpDir, 'ts_payload.json')
        await writeFile(payloadPath, JSON.stringify(payload), 'utf-8')

        const script = `
import sys, json
from test_scenarios_engine import TestScenariosEngine
try:
    engine = TestScenariosEngine(sys.argv[1])
    scenarios_result = engine.run_pipeline()
    print(json.dumps({"status":"success","message":"Test scenarios generated.","test_cases":scenarios_result.get("scenarios",[]),"document_path":"","md_path":""}))
except Exception as e:
    import traceback
    print(json.dumps({"status":"error","detail":str(e),"trace":traceback.format_exc()}))
`
        const raw = await runPythonEngine(script, payloadPath)
        const lines = raw.split('\n').filter(l => l.trim().startsWith('{'))
        const jsonLine = lines.length > 0 ? lines[lines.length - 1] : null

        if (!jsonLine) {
          sendJson(res, 500, { detail: `No valid JSON in Python output: ${raw.slice(0, 500)}` })
          return
        }

        let result: any
        try {
          result = JSON.parse(jsonLine)
        } catch (parseErr: any) {
          sendJson(res, 500, { detail: `Failed to parse Python output: ${parseErr.message}` })
          return
        }

        if (result.status === 'error') {
          sendJson(res, 500, { detail: result.detail || 'Unknown error in test scenario generation' })
        } else {
          sendJson(res, 200, result)
        }
      } catch (error: any) {
        sendJson(res, 500, { detail: error?.message || 'Test scenario generation failed' })
      }
    })

    // ── /api/artifact (file download) ─────────────────────────
    server.middlewares.use('/api/artifact', async (req: any, res: any, next: any) => {
      if (req.method !== 'GET') { next(); return }

      try {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        const filePath = url.searchParams.get('path') || ''
        const resolved = path.resolve(filePath)

        // Security: ensure file is inside .tmp
        if (!resolved.startsWith(tmpDir)) {
          sendJson(res, 403, { detail: 'Artifact path outside allowed folder' })
          return
        }

        const stats = await stat(resolved)
        if (!stats.isFile()) {
          sendJson(res, 404, { detail: 'Artifact not found' })
          return
        }

        const data = await readFile(resolved)
        const ext = path.extname(resolved).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.pdf': 'application/pdf',
        }
        res.statusCode = 200
        res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolved)}"`)
        res.end(data)
      } catch (error: any) {
        sendJson(res, 404, { detail: error?.message || 'Artifact not found' })
      }
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), verifyConnectionPlugin()],
})
