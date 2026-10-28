// A tiny, safe Markdown -> HTML renderer shared by the admin message editor and
// the employee message board. It escapes all HTML first, then applies a small
// set of formatting rules, so admin-authored content can never inject markup.
//
// Supported: # / ## / ### headings, **bold**, *italic*, `code`, - and 1. lists,
// [text](url) links, ![alt](url) images, --- horizontal rules, and paragraphs.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Only allow safe URL schemes on links/images (blocks javascript: etc.).
  function safeUrl(raw) {
    const url = String(raw).trim();
    if (/^(https?:|mailto:|\/|#)/i.test(url)) return url;
    return '#';
  }

  // Inline formatting, applied to already HTML-escaped text in ONE pass: each
  // piece of markup is matched once, left to right, and HTML this has written
  // is never scanned again. (It used to run a separate pass per rule, so a
  // later rule could reach inside an attribute an earlier one had written —
  // a link inside an image's alt text closed the attribute early.) Text
  // inside bold, italics and link labels is formatted the same way, from its
  // own escaped text; a link label can't hold another link or an image.
  //   ![alt](url)  [text](url)  **bold**  *italic*  `code`
  const INLINE = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  function inline(text, links = true) {
    return text.replace(INLINE, (m, alt, src, label, href, bold, em, code) => {
      // Lazy: a long message board shouldn't fetch every picture in its
      // history before the first post can scroll.
      if (src !== undefined)
        return links
          ? `<img src="${safeUrl(src)}" alt="${alt}" class="md-img" loading="lazy" decoding="async" />`
          : m;
      if (href !== undefined)
        return links
          ? `<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer">${inline(label, false)}</a>`
          : m;
      if (bold !== undefined) return `<strong>${inline(bold, links)}</strong>`;
      if (em !== undefined) return `<em>${inline(em, links)}</em>`;
      return `<code>${code}</code>`;
    });
  }

  function mdToHtml(src) {
    const lines = escapeHtml(String(src || '')).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol' while inside a list
    let para = [];

    const flushPara = () => {
      if (para.length) {
        out.push('<p>' + inline(para.join('<br>')) + '</p>');
        para = [];
      }
    };
    const closeList = () => {
      if (list) {
        out.push('</' + list + '>');
        list = null;
      }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); closeList(); continue; }

      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        flushPara(); closeList();
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      } else if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        flushPara(); closeList();
        out.push('<hr>');
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul>'); }
        out.push('<li>' + inline(m[1]) + '</li>');
      } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
        flushPara();
        if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol>'); }
        out.push('<li>' + inline(m[1]) + '</li>');
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return out.join('\n');
  }

  window.mdToHtml = mdToHtml;
})();
