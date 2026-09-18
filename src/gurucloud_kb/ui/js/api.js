/* KB Explorer API client — thin wrapper over one explorer base URL.

   The explorer talks to ONE route shape, `<base>/<resource>`, whatever is
   behind it:
     • in-app:  /api/kb-explorer/<kbId>        (session auth, admin-or-owner)
     • SDK:     /api/kb-explorer/<kbId>        served by gurucloud_kb.ui_server,
                which proxies to the public /api/v1/kb API with the API key
                kept server-side.
   One method per SDK-parity endpoint. Every call resolves to parsed JSON or
   throws an ApiError carrying {status, message, details} so views can render a
   toast and, for a playbook overlap (409), inspect details.candidates. */

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.details = details || null;
  }
}

function qs(params) {
  if (!params) return '';
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') u.append(k, v);
  });
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Default explorer base for a KB id (both hosts serve this shape). */
export function defaultBase(kbId) {
  return `/api/kb-explorer/${encodeURIComponent(kbId)}`;
}

/**
 * @param {string} kbId
 * @param {string} [base]   explorer base URL; `{kb}` inside it is replaced by kbId
 * @param {object} [opts]   { token: () => string|null } — when given, every call
 *                          carries `Authorization: Bearer <token>` (platform host)
 */
export function createApi(kbId, base, opts = {}) {
  const root = (base || defaultBase(kbId)).replace('{kb}', encodeURIComponent(kbId)).replace(/\/+$/, '');
  const tokenFn = typeof opts.token === 'function' ? opts.token : null;

  async function req(method, path, { body, params } = {}) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (tokenFn) {
      const t = tokenFn();
      if (t) init.headers.Authorization = `Bearer ${t}`;
    }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let resp;
    try {
      resp = await fetch(`${root}${path}${qs(params)}`, init);
    } catch (e) {
      throw new ApiError('Network error — is the KB service reachable?', 0);
    }
    let data = null;
    const text = await resp.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    // The self-hosted platform answers in the public-API envelope
    // ({"data": …} / {"error": {code, message, details}}); the hosted app and
    // the SDK server answer bare. Accept both.
    const isEnvelope = data && typeof data === 'object' && !Array.isArray(data) && ('data' in data || (data.error && typeof data.error === 'object')) && Object.keys(data).every((k) => k === 'data' || k === 'meta' || k === 'error');
    if (!resp.ok) {
      if (resp.status === 401 && tokenFn) {
        // Platform host: the stored service token is wrong or expired.
        try { sessionStorage.removeItem('kbx-token'); } catch { /* ignore */ }
        throw new ApiError('Service token rejected (401). Reload the page and enter it again.', 401, null);
      }
      let msg = (data && typeof data === 'object' && (data.error || data.detail)) || `HTTP ${resp.status}`;
      let details = (data && typeof data === 'object' && data.details) || null;
      if (isEnvelope && data.error && typeof data.error === 'object') {
        msg = data.error.message || data.error.code || msg;
        details = data.error.details || null;
      }
      throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), resp.status, details);
    }
    return isEnvelope && 'data' in data ? data.data : data;
  }

  return {
    kbId,
    base: root,
    // bank + schema
    info: () => req('GET', '/info'),
    getSchema: () => req('GET', '/schema'),
    putSchema: (schema) => req('PUT', '/schema', { body: schema }),
    validateSchema: (schema) => req('POST', '/schema/validate', { body: schema }),
    addDimension: (dim) => req('POST', '/dimensions', { body: dim }),
    removeDimension: (name) => req('DELETE', `/dimensions/${encodeURIComponent(name)}`),
    // entries
    listEntries: (params) => req('GET', '/entries', { params }),
    addEntry: (entry) => req('POST', '/entries', { body: entry }),
    getEntry: (id) => req('GET', `/entries/${encodeURIComponent(id)}`),
    updateEntry: (id, updates) => req('PATCH', `/entries/${encodeURIComponent(id)}`, { body: updates }),
    deleteEntry: (id) => req('DELETE', `/entries/${encodeURIComponent(id)}`),
    // search + cluster
    search: (payload) => req('POST', '/search', { body: payload }),
    cluster: (payload) => req('POST', '/cluster', { body: payload }),
    // assertions
    listAssertions: (params) => req('GET', '/assertions', { params }),
    createAssertion: (payload) => req('POST', '/assertions', { body: payload }),
    deleteAssertion: (id) => req('DELETE', `/assertions/${encodeURIComponent(id)}`),
    // retrieval eval
    runEval: () => req('POST', '/retrieval-eval/run'),
    listEvalRuns: (params) => req('GET', '/retrieval-eval/runs', { params }),
    getEvalRun: (id) => req('GET', `/retrieval-eval/runs/${encodeURIComponent(id)}`),
    // stats + mcp
    stats: () => req('GET', '/stats'),
    mcpConfig: () => req('GET', '/mcp-config'),
    mcpTools: () => req('GET', '/mcp-tools'),
    mcpServerDefinition: () => req('GET', '/mcp-server-definition'),
    // history
    recentQueries: (params) => req('GET', '/queries', { params }),
    listEvents: (params) => req('GET', '/events', { params }),
    getEvent: (id) => req('GET', `/events/${encodeURIComponent(id)}`),
    listEventLogs: (params) => req('GET', '/event-logs', { params }),
    // playbooks
    listPlaybooks: (params) => req('GET', '/playbooks', { params }),
    playbookStats: () => req('GET', '/playbook-stats'),
    getPlaybook: (slug, params) => req('GET', `/playbooks/${encodeURIComponent(slug)}`, { params }),
    upsertPlaybook: (slug, body, params) => req('PUT', `/playbooks/${encodeURIComponent(slug)}`, { body, params }),
    deletePlaybook: (slug, params) => req('DELETE', `/playbooks/${encodeURIComponent(slug)}`, { params }),
    listPlaybookVersions: (slug) => req('GET', `/playbooks/${encodeURIComponent(slug)}/versions`),
  };
}
