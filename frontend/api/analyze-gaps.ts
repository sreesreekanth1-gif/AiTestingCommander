import { VercelRequest, VercelResponse } from '@vercel/node';

const extractText = (value: any): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') {
    const parts: string[] = [];
    if (value.text) parts.push(String(value.text));
    if (value.content) parts.push(extractText(value.content));
    if (value.items) parts.push(extractText(value.items));
    return parts.filter(Boolean).join(' ').trim();
  }
  return String(value);
};

const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 20000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal as AbortSignal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const requireFields = (payload: any, fields: string[], toolName: string) => {
  const missing = fields.filter((f) => !(payload[f] || '').trim());
  if (missing.length) throw new Error(`${toolName}: ${missing.join(', ')} are required for gap analysis.`);
};

const fetchJiraIssueContext = async (payload: any): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '');
  const issueId = (payload.issueId || '').trim();
  requireFields(payload, ['baseUrl', 'username', 'token', 'issueId'], 'Jira');

  const auth = Buffer.from(`${payload.username}:${payload.token}`).toString('base64');
  const url = `${normalized}/rest/api/3/issue/${issueId}?fields=summary,description,issuetype,priority,labels,components`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  });

  if (!response.ok) throw new Error(`Jira issue fetch failed with status ${response.status}`);

  const data = await response.json();
  const fields = data.fields || {};
  return [
    `Issue ID: ${issueId}`,
    `Title: ${extractText(fields.summary)}`,
    `Description: ${extractText(fields.description)}`,
  ].join('\n').trim();
};

const fetchADOIssueContext = async (payload: any): Promise<string> => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '');
  const issueId = (payload.issueId || '').trim();
  requireFields(payload, ['baseUrl', 'token', 'issueId'], 'ADO');

  const auth = Buffer.from(`:${payload.token}`).toString('base64');
  const url = `${normalized}/_apis/wit/workitems/${issueId}?$expand=all&api-version=7.1`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  });

  if (!response.ok) throw new Error(`ADO work item fetch failed with status ${response.status}`);

  const data = await response.json();
  const f = data.fields || {};
  return [
    `Work Item ID: ${issueId}`,
    `Title: ${extractText(f['System.Title'])}`,
    `Description: ${extractText(f['System.Description'])}`,
  ].join('\n').trim();
};

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
${contextText}`;

const analyzeGapsInternal = async (payload: any, contextText: string): Promise<any> => {
  const issueId = (payload.issueId || 'UNKNOWN').trim();
  if (payload.llmProvider === 'GROQ') {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${payload.llmApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: payload.llmModel || 'llama-3.1-70b-versatile',
        messages: [{ role: 'user', content: buildGapPrompt(issueId, contextText) }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`GROQ analysis failed with status ${response.status}`);
    const result = await response.json();
    const raw = result.choices?.[0]?.message?.content?.trim();
    return JSON.parse(raw);
  }
  throw new Error(`Cloud analysis not yet implemented for ${payload.llmProvider} in serverless mode.`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method Not Allowed' });

  try {
    const payload = req.body;
    let contextText = '';
    if (payload.selectedTool === 'Jira') contextText = await fetchJiraIssueContext(payload);
    else if (payload.selectedTool === 'ADO') contextText = await fetchADOIssueContext(payload);
    else throw new Error(`Gap analysis not supported for tool: ${payload.selectedTool}`);

    const analysis = await analyzeGapsInternal(payload, contextText);
    res.status(200).json({ status: 'success', analysis });
  } catch (error: any) {
    res.status(400).json({ detail: error?.message || 'Gap analysis failed' });
  }
}
