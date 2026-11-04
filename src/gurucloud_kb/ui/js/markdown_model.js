/* Markdown for Knowledge Bank entries — pure, escape-first, no dependency.

   Entry content and useful_for are agent-authored markdown (the report_learning
   description asks for headings, bullets, backticked identifiers and fenced
   commands). renderMarkdown() turns that into HTML for the Explorer; every
   character of the source is HTML-escaped BEFORE any markdown pass, so a
   literal tag in an entry renders as visible text and only the elements this
   module emits reach the page. Link hrefs are scheme-checked (http, https,
   mailto, tel) because escaping alone cannot stop `[x](javascript:...)`.
   Unlike the server-side utils/markdown_render.py (same escape-first order),
   blockquotes do render here: the block scanner matches the escaped `&gt;`.

   Supported: ATX headings, paragraphs (single newlines become <br>, like the
   server-side nl2br renderer), unordered and ordered lists nested by
   indentation, blockquotes, fenced code blocks, pipe tables, horizontal rules,
   bold, italic, strikethrough, inline code, links and bare URLs.
   markdownToText() strips the same syntax for one-line previews (list cards,
   tooltips). Node-tested in tests/test_kb_explorer_markdown_model.js. */

const SAFE_SCHEMES = /^(https?:|mailto:|tel:)/i;

export function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHref(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (/^#/.test(u) || /^\//.test(u)) return u;              // in-page or site-relative
  return SAFE_SCHEMES.test(u) ? u : null;
}

/** Inline markdown on an already-escaped line. Code spans are protected first
    so emphasis and link syntax inside backticks stays literal. */
export function renderInline(escaped) {
  const codes = [];
  let s = String(escaped).replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // [text](url) — url is escaped text, so &amp; is already correct inside href.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : m;
  });
  // <https://...> autolinks (escaped to &lt;...&gt; by now)
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s]+?)&gt;/g, (m, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${url}</a>` : m;
  });
  // bare URLs (not already inside an href="..." or an anchor's text)
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+?)(?=[.,;:!?)]*(?:[\s<]|$))/g, (m, lead, url) => {
    if (/href=&quot;$|href="$/.test(lead)) return m;
    return `${lead}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // emphasis opens only against a non-space and closes only after one, so
  // "2 * 3 * 4" and "a * b" stay arithmetic
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RE_HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const RE_UL = /^(\s*)([-*+•])\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RE_QUOTE = /^\s*&gt;\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableRow(line) { return /\|/.test(line) && !RE_FENCE.test(line); }
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function blank(line) { return !line || !line.trim(); }
function isBlockStart(line) {
  return RE_HEADING.test(line) || RE_FENCE.test(line) || RE_HR.test(line) || RE_UL.test(line) || RE_OL.test(line) || RE_QUOTE.test(line);
}
function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Render markdown to an HTML string. Output is wrapped by the caller. */
export function renderMarkdown(text) {
  const src = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i += 1; continue; }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].match(RE_FENCE) && lines[i].match(RE_FENCE)[1] === fence[1])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or EOF)
      while (body.length && !body[body.length - 1].trim()) body.pop();
      const lang = fence[2] ? ` data-lang="${fence[2]}"` : '';
      out.push(`<pre class="kbx-code"${lang}><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1; continue;
    }
    if (RE_HR.test(line)) { out.push('<hr>'); i += 1; continue; }

    if (RE_QUOTE.test(line)) {
      const q = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { q.push(lines[i].match(RE_QUOTE)[1]); i += 1; }
      // the quoted lines are escaped text; the recursive pass escapes again, so hand it the source form
      out.push(`<blockquote>${renderMarkdown(unescapeHtml(q.join('\n')))}</blockquote>`);
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const items = [];
      while (i < lines.length && !blank(lines[i]) && !RE_HEADING.test(lines[i]) && !RE_FENCE.test(lines[i])) {
        const m = lines[i].match(RE_UL) || lines[i].match(RE_OL);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: /\d/.test(m[2]) ? Number(m[2]) : null, text: [m[3]] });
        } else if (items.length && /^\s+/.test(lines[i])) {
          items[items.length - 1].text.push(lines[i].trim());      // indented continuation
        } else if (items.length && !isBlockStart(lines[i]) && !isTableRow(lines[i])) {
          items[items.length - 1].text.push(lines[i].trim());      // lazy continuation
        } else break;
        i += 1;
      }
      // a blank line ends the list; a bullet after it starts a new one
      out.push(renderList(items));
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && isTableRow(lines[i + 1])) {
      const head = splitCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && isTableRow(lines[i])) { rows.push(splitCells(lines[i])); i += 1; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead>'
        + (rows.length ? '<tbody>' + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${renderInline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody>' : '')
        + '</table>');
      continue;
    }

    // paragraph: until a blank line or a block start
    const para = [line];
    i += 1;
    while (i < lines.length && !blank(lines[i]) && !isBlockStart(lines[i]) && !(isTableRow(lines[i]) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))) { para.push(lines[i]); i += 1; }
    out.push(`<p>${para.map((l) => renderInline(l.trim())).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function renderList(items) {
  // Build a tree from indentation; a deeper indent nests under the previous item.
  let pos = 0;
  function build(indent) {
    const ordered = items[pos].ordered;
    const start = items[pos].start;
    const lis = [];
    while (pos < items.length && items[pos].indent >= indent) {
      if (items[pos].indent > indent) {
        if (!lis.length) { lis.push('<li>'); }
        lis[lis.length - 1] = lis[lis.length - 1].replace(/<\/li>$/, '') + build(items[pos].indent) + '</li>';
        continue;
      }
      const it = items[pos];
      pos += 1;
      lis.push(`<li>${it.text.map((t) => renderInline(t)).join('<br>')}</li>`);
    }
    const attr = ordered && start && start !== 1 ? ` start="${start}"` : '';
    return `<${ordered ? 'ol' : 'ul'}${attr}>${lis.join('')}</${ordered ? 'ol' : 'ul'}>`;
  }
  let html = '';
  while (pos < items.length) html += build(items[pos].indent);
  return html;
}

/** Plain text for previews: markdown markers dropped, whitespace collapsed. */
export function markdownToText(text) {
  const src = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
  const lines = [];
  let inFence = false;
  for (const raw of src.split('\n')) {
    if (RE_FENCE.test(raw)) { inFence = !inFence; continue; }
    if (inFence) { lines.push(raw.trim()); continue; }
    if (RE_TABLE_SEP.test(raw) && /\|/.test(raw)) continue;
    if (RE_HR.test(raw)) continue;
    let l = raw.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^(\s*)([-*+•]|\d{1,3}[.)])\s+/, '$1');
    if (/\|/.test(l)) l = splitCells(l).join(' · ');
    lines.push(l.trim());
  }
  return lines.join(' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heuristic used by hosts that want to skip the renderer for plain prose. */
export function looksLikeMarkdown(text) {
  const s = String(text || '');
  if (/```/.test(s)) return true;
  let structural = 0;
  for (const line of s.split('\n')) if (RE_HEADING.test(line) || RE_UL.test(line) || RE_OL.test(line) || RE_TABLE_SEP.test(line)) structural += 1;
  return structural >= 2 || /\*\*[^*\n]+\*\*/.test(s) || /`[^`\n]+`/.test(s);
}
