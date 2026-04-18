import { VercelRequest, VercelResponse } from '@vercel/node';

const normalizeModelName = (value: string | undefined) => (value || '').trim().toLowerCase();

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

const verifyHostedProvider = async (payload: any) => {
  const provider = payload.llmProvider;
  const apiKey = (payload.llmApiKey || '').trim();
  const requestedModel = normalizeModelName(payload.llmModel);

  if (!apiKey) throw new Error('Missing API Key.');
  if (!requestedModel) throw new Error('Missing Model Name.');

  let url = '';
  let headers: Record<string, string> = {};
  let extractModels = (data: any): string[] => [];

  if (provider === 'Anthropic') {
    url = 'https://api.anthropic.com/v1/models';
    headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    };
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : [];
  } else if (provider === 'GROQ') {
    url = 'https://api.groq.com/openai/v1/models';
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : [];
  } else if (provider === 'Grok') {
    url = 'https://api.x.ai/v1/models';
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : [];
  } else if (provider === 'OpenRouter') {
    url = 'https://openrouter.ai/api/v1/models';
    headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    extractModels = (data) =>
      Array.isArray(data?.data)
        ? data.data.map((model: any) => normalizeModelName(model.id)).filter(Boolean)
        : [];
  } else {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers,
  }, 20000);

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Invalid ${provider} API key.`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${provider} verification failed with status ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  }

  const data = await response.json();
  const availableModels = extractModels(data);

  if (!availableModels.length) {
    throw new Error(`Unable to load ${provider} models for verification.`);
  }

  const requested = requestedModel;
  if (!availableModels.includes(requested)) {
    const similar = availableModels.filter((m: string) => m.includes(requested));
    const suggestionHeader = similar.length ? 'Top suggestions' : 'Available samples';
    const listToShow = similar.length ? similar.slice(0, 15) : availableModels.slice(0, 15);
    const suggestionStr = listToShow.join(', ');
    
    throw new Error(
      `Model '${payload.llmModel}' not found for ${provider}. ` +
      `${suggestionHeader}: ${suggestionStr} (Total: ${availableModels.length})`
    );
  }
};

const buildAlmRequest = (payload: any) => {
  const normalized = (payload.baseUrl || '').trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  let url = normalized;

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('Invalid Base URL format');
  }

  if (payload.selectedTool === 'Jira') {
    url = `${normalized}/rest/api/3/myself`;
    headers.Authorization = `Basic ${Buffer.from(`${payload.username}:${payload.token}`).toString('base64')}`;
  } else if (payload.selectedTool === 'ADO') {
    url = `${normalized}/_apis/projects?api-version=7.1`;
    headers.Authorization = `Basic ${Buffer.from(`:${payload.token}`).toString('base64')}`;
  } else if (payload.selectedTool === 'TestRail') {
    url = `${normalized}/index.php?/api/v2/get_case_fields`;
    headers.Authorization = `Basic ${Buffer.from(`${payload.username}:${payload.token}`).toString('base64')}`;
  } else if (payload.selectedTool === 'QTest') {
    url = `${normalized}/api/v3/projects`;
    headers.Authorization = `Bearer ${payload.token}`;
  } else {
    throw new Error(`${payload.selectedTool} verification is not implemented yet`);
  }

  return { url, headers };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ detail: 'Method Not Allowed' });
  }

  try {
    const payload = req.body;

    if (payload.type === 'ALM') {
      if (!payload.baseUrl || (!payload.token && payload.selectedTool !== 'X-Ray')) {
        return res.status(400).json({ detail: 'Missing ALM Credentials' });
      }

      const { url, headers } = buildAlmRequest(payload);
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
      });

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      if ([401, 403].includes(response.status)) {
        return res.status(401).json({ detail: 'Invalid User or Token Auth' });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        return res.status(400).json({ detail: 'Platform redirected the request. Check the workspace URL and API path.' });
      }

      if (response.status === 404) {
        return res.status(404).json({ detail: `Platform API endpoint not found at ${url}` });
      }

      if (contentType.includes('text/html')) {
        return res.status(401).json({ detail: 'Authentication Rejected (Received login webpage)' });
      }

      if (!response.ok) {
        return res.status(400).json({ detail: text || `Platform validation failed with status ${response.status}` });
      }

      return res.status(200).json({ status: 'success', message: 'Connection Validated' });
    }

    if (payload.type === 'AI') {
      const modelName = normalizeModelName(payload.llmModel);
      if (!modelName) {
        return res.status(400).json({ detail: 'Missing Model Name' });
      }

      if (payload.llmProvider === 'Ollama') {
        const endpoint = (payload.llmEndpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) {
          return res.status(400).json({ detail: 'Missing Endpoint' });
        }

        const response = await fetch(`${endpoint}/api/tags`);
        if (!response.ok) {
          return res.status(400).json({ detail: `Ollama endpoint returned ${response.status}` });
        }

        const data = await response.json();
        const availableModels = Array.isArray(data.models)
          ? data.models
              .map((model: any) => normalizeModelName(model.name || model.model))
              .filter(Boolean)
          : [];

        if (!availableModels.includes(modelName)) {
           return res.status(400).json({ detail: `Model '${payload.llmModel}' was not found on the Ollama endpoint.` });
        }

        return res.status(200).json({ status: 'success', message: 'Connection Validated' });
      }

      await verifyHostedProvider(payload);
      return res.status(200).json({ status: 'success', message: 'Connection Validated' });
    }

    return res.status(400).json({ detail: 'Unsupported verification type' });
  } catch (error: any) {
    return res.status(502).json({ detail: error?.message || 'Verification request failed' });
  }
}
