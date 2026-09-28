/* ============================================================================
 * StudyOS drills — trace the code ("what does this print?")
 * ============================================================================
 * Java snippets on the course's topics (recursion, generics, lists, stacks,
 * queues, trees, hashing). She types the exact output; comparison forgives
 * spacing but not content (quiz.normalizeOutput). Kit `trace` questions from
 * study kits use the same comparison in quiz mode.
 * ------------------------------------------------------------------------- */

import { normalizeOutput } from '../../quiz.js';

export const BANK = [
  { topic: 'Recursion', code: 'static int f(int n) {\n  if (n == 0) return 0;\n  return n + f(n - 1);\n}\n// main:\nSystem.out.println(f(4));', out: '10', why: '4 + 3 + 2 + 1 + 0.' },
  { topic: 'Recursion', code: 'static void p(int n) {\n  if (n == 0) return;\n  p(n - 1);\n  System.out.print(n + " ");\n}\n// main:\np(3);', out: '1 2 3', why: 'The print happens AFTER the recursive call, so it runs on the way back up.' },
  { topic: 'Recursion', code: 'static void p(int n) {\n  if (n == 0) return;\n  System.out.print(n + " ");\n  p(n - 1);\n}\n// main:\np(3);', out: '3 2 1', why: 'Print before recursing: on the way down.' },
  { topic: 'Recursion', code: 'static int g(int n) {\n  if (n <= 1) return 1;\n  return g(n - 1) + g(n - 2);\n}\n// main:\nSystem.out.println(g(5));', out: '8', why: 'g(0)=g(1)=1, then 2, 3, 5, 8.' },
  { topic: 'Stacks', code: 'Deque<Integer> s = new ArrayDeque<>();\ns.push(1); s.push(2); s.push(3);\ns.pop();\ns.push(4);\nSystem.out.println(s.peek() + " " + s.size());', out: '4 3', why: 'After pushes 1,2,3 then pop (3) and push 4: top is 4, size 3.' },
  { topic: 'Queues', code: 'Queue<String> q = new LinkedList<>();\nq.add("a"); q.add("b"); q.add("c");\nq.remove();\nq.add("d");\nSystem.out.println(q.peek() + q.size());', out: 'b3', why: 'FIFO: removing takes "a"; the front is now "b".' },
  { topic: 'Lists', code: 'List<Integer> a = new ArrayList<>(List.of(5, 6, 7));\na.add(1, 9);\na.remove(Integer.valueOf(7));\nSystem.out.println(a);', out: '[5, 9, 6]', why: 'add(1, 9) inserts at index 1; remove(Integer) removes the VALUE 7.' },
  { topic: 'Lists', code: 'List<Integer> a = new ArrayList<>(List.of(5, 6, 7));\na.remove(1);\nSystem.out.println(a);', out: '[5, 7]', why: 'remove(int) removes by INDEX — the classic trap next to remove(Integer).' },
  { topic: 'Generics', code: 'static <T extends Comparable<T>> T max(T a, T b) {\n  return a.compareTo(b) >= 0 ? a : b;\n}\n// main:\nSystem.out.println(max("pear", "apple"));', out: 'pear', why: 'Strings compare alphabetically; "pear" > "apple".' },
  { topic: 'Big-O', code: 'int c = 0;\nfor (int i = 1; i < 16; i *= 2) c++;\nSystem.out.println(c);', out: '4', why: 'i = 1, 2, 4, 8 — four iterations (log₂ 16).' },
  { topic: 'Trees', code: '// BST built by inserting 8, 3, 10, 1, 6\n// In-order traversal prints:', out: '1 3 6 8 10', why: 'In-order on a BST always gives sorted order.' },
  { topic: 'Trees', code: '// BST built by inserting 8, 3, 10, 1, 6\n// PRE-order traversal prints:', out: '8 3 1 6 10', why: 'Root, then left subtree, then right subtree.' },
  { topic: 'Trees', code: '// BST built by inserting 8, 3, 10, 1, 6\n// POST-order traversal prints:', out: '1 6 3 10 8', why: 'Left subtree, right subtree, then the root.' },
  { topic: 'Hashing', code: 'int[] t = new int[7];\nint k = 23;\nSystem.out.println(k % t.length);', out: '2', why: '23 = 3·7 + 2.' },
  { topic: 'Heaps', code: 'PriorityQueue<Integer> pq = new PriorityQueue<>();\npq.add(5); pq.add(1); pq.add(8); pq.add(3);\nSystem.out.print(pq.poll() + " ");\nSystem.out.print(pq.poll());', out: '1 3', why: 'Java\'s PriorityQueue is a min-heap: smallest first.' },
  { topic: 'Loops', code: 'int x = 0;\nfor (int i = 0; i < 3; i++)\n  for (int j = i; j < 3; j++)\n    x++;\nSystem.out.println(x);', out: '6', why: '3 + 2 + 1.' },
];

const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function mount(host, ctx) {
  const { esc } = ctx;
  const deck = shuffle(BANK);
  let i = 0;
  const show = () => {
    const it = deck[i % deck.length];
    host.innerHTML = `<div class="sp-muted" style="font-family:var(--mono);font-size:11px;margin-bottom:6px">${esc(it.topic)} · ${(i % deck.length) + 1}/${deck.length}</div>
      <div class="sp-code">${esc(it.code)}</div>
      <div style="margin:10px 0 6px">What is printed?</div>
      <input class="sp-input" data-a style="width:100%" placeholder="exact output" autocomplete="off">
      <div class="sp-row" style="margin-top:8px"><button class="sp-btn primary" data-check>Check</button><button class="sp-btn" data-skip>Skip</button></div>
      <div data-fb style="margin-top:10px;font-size:14px"></div>`;
    const inp = host.querySelector('[data-a]');
    const check = () => {
      const ok = normalizeOutput(inp.value) === normalizeOutput(it.out);
      ctx.record({ topic: 'Trace: ' + it.topic, correct: ok, difficulty: 2 });
      host.querySelector('[data-check]').disabled = true;
      host.querySelector('[data-fb]').innerHTML = `<span class="${ok ? 'sp-ok' : 'sp-bad'}">${ok ? '✓ Right' : '✗ It prints <code>' + esc(it.out) + '</code>'}</span>
        <div class="sp-muted" style="margin-top:4px">${esc(it.why)}</div><button class="sp-btn primary" data-next style="margin-top:8px">Next</button>`;
      host.querySelector('[data-next]').onclick = () => { i++; show(); };
    };
    host.querySelector('[data-check]').onclick = check;
    host.querySelector('[data-skip]').onclick = () => { i++; show(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !host.querySelector('[data-check]').disabled) check(); });
    inp.focus();
  };
  show();
  return null;
}

export default { mount, BANK };
