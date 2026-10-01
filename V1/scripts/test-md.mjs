// Tests for js/modules/md.js — the ONLY path AI-written text takes to the page.
//
// The case this file exists for:
//
//   "a lesson can never inject markup"
//       Lessons are model output rendered with innerHTML. A lesson ABOUT HTML
//       (or a hostile document) that says <script> or <img onerror> must show
//       those characters, never run them — including inside code, tables and
//       headings, where a renderer is most tempted to pass text through.
//
// Run with:  node scripts/test-md.mjs
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 300))); }
};

const { renderMarkdown, inline, escapeHtml } = await import(new URL('../js/modules/md.js', import.meta.url).href);

console.log('\nescaping');
{
  const h = renderMarkdown('Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>');
  t('no live <script>', !/<script/i.test(h), h);
  t('no live <img>', !/<img/i.test(h), h);
  t('the characters are shown', h.includes('&lt;script&gt;'), h);
  const code = renderMarkdown('```html\n<b onclick="x()">hi</b>\n```');
  t('fenced code is escaped', code.includes('&lt;b onclick=') && !/<b /.test(code), code);
  const table = renderMarkdown('| a | b |\n|---|---|\n| <i>x</i> | `<u>` |');
  t('table cells are escaped', !/<i>|<u>/.test(table) && table.includes('&lt;i&gt;'), table);
  const head = renderMarkdown('## <svg onload=alert(1)>');
  t('headings are escaped', !/<svg/i.test(head), head);
  // Lesson figures are built as elements by lesson-ui, never through markdown.
  const pic = renderMarkdown('![x](javascript:alert(1)) and ![y](data:image/svg+xml,<svg onload=alert(1)>)');
  t('image syntax never becomes an <img>', !/<img|<svg/i.test(pic), pic);
  t('quotes escaped for attributes too', escapeHtml(`"'`) === '&quot;&#39;');
}

console.log('\nstructure');
{
  const h = renderMarkdown('## Title\n\nPara one\ncontinues.\n\n- a\n- b\n\n1. x\n2. y\n\n> note');
  t('heading', /<h3>Title<\/h3>/.test(h), h);
  t('paragraph joins wrapped lines', h.includes('<p>Para one continues.</p>'), h);
  t('bullet list', /<ul><li>a<\/li><li>b<\/li><\/ul>/.test(h), h);
  t('numbered list', /<ol><li>x<\/li><li>y<\/li><\/ol>/.test(h), h);
  t('blockquote', h.includes('<blockquote>note</blockquote>'), h);
  const code = renderMarkdown('```sql\nSELECT *\n  FROM t;\n```');
  t('code keeps its lines and indentation', code.includes('SELECT *\n  FROM t;'), code);
  const table = renderMarkdown('| Term | Meaning |\n| --- | --- |\n| 1NF | atomic values |\n| 2NF | no partial deps |');
  t('table renders a header', table.includes('<th>Term</th>') && table.includes('<th>Meaning</th>'), table);
  t('table renders rows', (table.match(/<tr>/g) || []).length === 3, table);
  t('a lone pipe line stays text', renderMarkdown('a | b').includes('<p>'));
}

console.log('\ninline');
{
  t('bold', inline('**x**') === '<strong>x</strong>');
  t('italic', inline('an *idea* here') === 'an <em>idea</em> here');
  t('asterisks inside code are not emphasis', inline('`a*b*c`') === '<code>a*b*c</code>', inline('`a*b*c`'));
  t('multiplication is not emphasis', !inline('2 * 3 * 4').includes('<em>'), inline('2 * 3 * 4'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
