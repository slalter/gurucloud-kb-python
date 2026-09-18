/* Connect view — the SDK & MCP surface for this KB: what an SDK client or agent
   sees. MCP config + copy-paste .mcp.json, the server definition, and the
   generated MCP tool definitions. Mirrors the SDK's get_mcp_config /
   get_mcp_server_definition / get_mcp_tools. */

import { h, mount, clear, toast, skeleton, copy } from './dom.js';

export function createConnectView(ctx) {
  const { api } = ctx;
  const el = h('div', {});
  let loaded = false;
  const host = h('div', {});
  mount(el, host);

  async function load() {
    mount(host, skeleton('Loading connection surface…'));
    const [cfg, def, tools] = await Promise.allSettled([api.mcpConfig(), api.mcpServerDefinition(), api.mcpTools()]);
    const blocks = [];

    // MCP config + .mcp.json
    if (cfg.status === 'fulfilled') {
      const c = cfg.value;
      const snippet = JSON.stringify(c.mcp_config || {}, null, 2);
      blocks.push(card('Connect this KB', [
        c.mcp_url ? copyRow('MCP server URL', c.mcp_url) : null,
        h('div', { class: 'kbx-field' }, h('label', {}, '.mcp.json'),
          h('div', { style: { position: 'relative' } },
            h('button', { class: 'kbx-btn kbx-btn-ghost kbx-btn-sm', type: 'button', style: { position: 'absolute', top: '8px', right: '8px' }, onClick: () => copy(snippet, 'Snippet copied') }, h('i', { class: 'bi bi-clipboard' }), 'Copy'),
            h('pre', { class: 'kbx-code' }, snippet))),
        Array.isArray(c.instructions) && c.instructions.length ? h('div', { class: 'kbx-field' }, h('label', {}, 'Setup'), h('ol', { style: { margin: 0, paddingLeft: '18px', color: 'var(--kbx-body)', fontSize: '14px', lineHeight: '1.7' } }, ...c.instructions.map((s) => h('li', {}, String(s).replace(/^\d+\.\s*/, ''))))) : null,
      ]));
    } else {
      blocks.push(errCard('Connect this KB', cfg.reason));
    }

    // Server definition
    if (def.status === 'fulfilled') {
      const d = def.value || {};
      const toolNames = d.available_tools || [];
      blocks.push(card('Server definition', [
        h('dl', { class: 'kbx-kv' },
          h('dt', {}, 'Server name'), h('dd', {}, d.server_name || '—'),
          h('dt', {}, 'Type'), h('dd', {}, d.type || '—'),
          h('dt', {}, 'URL'), h('dd', { class: 'kbx-mono', style: { fontSize: '12px' } }, d.url || '—'),
          h('dt', {}, 'Auth'), h('dd', {}, typeof d.auth === 'object' ? JSON.stringify(d.auth) : (d.auth || '—')),
          h('dt', {}, 'Description'), h('dd', {}, d.description || '—')),
        toolNames.length ? h('div', { class: 'kbx-field kbx-mt' }, h('label', {}, `Available tools (${toolNames.length})`), h('div', { class: 'kbx-tags' }, ...toolNames.map((t) => h('span', { class: 'kbx-chip' }, typeof t === 'string' ? t : (t.name || ''))))) : null,
      ]));
    }

    // Generated tool definitions
    if (tools.status === 'fulfilled') {
      const t = tools.value;
      const list = Array.isArray(t) ? t : (t.tools || t.mcp_tools || []);
      const toolCards = list.map((tool) => h('div', { class: 'kbx-item', style: { cursor: 'default' } },
        h('div', { class: 'kbx-item-head' }, h('span', { class: 'kbx-strong kbx-mono' }, tool.name || '(tool)'), tool.input_schema || tool.inputSchema ? h('span', { class: 'kbx-chip muted' }, 'has schema') : null),
        tool.description ? h('div', { class: 'kbx-item-body kbx-muted' }, truncate(tool.description, 260)) : null));
      blocks.push(card(`Generated MCP tools${list.length ? ` (${list.length})` : ''}`, [
        h('div', { class: 'kbx-card-sub', style: { marginBottom: '10px' } }, 'The tool definitions an agent receives for this KB, generated from its schema.'),
        list.length ? h('div', { class: 'kbx-list' }, ...toolCards) : h('div', { class: 'kbx-muted' }, 'No tools reported.'),
      ]));
    }

    mount(host, ...blocks);
  }

  function card(title, children) {
    return h('div', { class: 'kbx-card' }, h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, title)), ...children.filter(Boolean));
  }
  function errCard(title, reason) {
    return h('div', { class: 'kbx-card' }, h('div', { class: 'kbx-card-head' }, h('h3', { class: 'kbx-card-title' }, title)), h('div', { class: 'kbx-alert warn' }, (reason && reason.message) || 'Unavailable'));
  }
  function copyRow(label, value) {
    const input = h('input', { class: 'kbx-input kbx-mono', readonly: true, value });
    return h('div', { class: 'kbx-field' }, h('label', {}, label), h('div', { class: 'kbx-copy-row' }, input, h('button', { class: 'kbx-btn kbx-btn-ghost', type: 'button', onClick: () => copy(value, 'Copied') }, h('i', { class: 'bi bi-clipboard' }))));
  }
  function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }

  return {
    el,
    load() { if (!loaded) { loaded = true; load(); } },
    reload: load,
  };
}
