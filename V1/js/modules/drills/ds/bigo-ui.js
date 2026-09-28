/* ============================================================================
 * StudyOS drills — Big-O rapid fire
 * ============================================================================
 * A Java snippet, six complexities, a 60-second round. Each answer shows WHY
 * (one line), because a streak of lucky guesses teaches nothing. Every snippet
 * is in terms of n = the input size named in its comment.
 * ------------------------------------------------------------------------- */

export const OPTIONS = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)'];

export const BANK = [
  { code: 'int first(int[] a) {\n  return a[0];\n}', ans: 'O(1)', why: 'One array access, regardless of n.' },
  { code: 'int sum(int[] a) {\n  int s = 0;\n  for (int x : a) s += x;\n  return s;\n}', ans: 'O(n)', why: 'One pass over n elements.' },
  { code: 'for (int i = 0; i < n; i++)\n  for (int j = 0; j < n; j++)\n    count++;', ans: 'O(n²)', why: 'n iterations of an n-iteration loop.' },
  { code: 'for (int i = 0; i < n; i++)\n  for (int j = i; j < n; j++)\n    count++;', ans: 'O(n²)', why: 'n + (n−1) + … + 1 = n(n+1)/2, still quadratic.' },
  { code: 'int i = n;\nwhile (i > 1) {\n  i = i / 2;\n  count++;\n}', ans: 'O(log n)', why: 'Halving n each step takes log₂ n steps.' },
  { code: 'for (int i = 1; i < n; i *= 2)\n  count++;', ans: 'O(log n)', why: 'i doubles: 1, 2, 4, … reaches n after log₂ n steps.' },
  { code: 'for (int i = 0; i < n; i++)\n  for (int j = 1; j < n; j *= 2)\n    count++;', ans: 'O(n log n)', why: 'n outer iterations × log n inner.' },
  { code: 'int binarySearch(int[] a, int key) {\n  int lo = 0, hi = a.length - 1;\n  while (lo <= hi) {\n    int mid = (lo + hi) / 2;\n    if (a[mid] == key) return mid;\n    if (a[mid] < key) lo = mid + 1; else hi = mid - 1;\n  }\n  return -1;\n}', ans: 'O(log n)', why: 'The search range halves every iteration.' },
  { code: 'int fib(int n) {\n  if (n < 2) return n;\n  return fib(n - 1) + fib(n - 2);\n}', ans: 'O(2ⁿ)', why: 'Each call makes two more: the call tree roughly doubles per level.' },
  { code: 'int fact(int n) {\n  if (n <= 1) return 1;\n  return n * fact(n - 1);\n}', ans: 'O(n)', why: 'One recursive call per level, n levels.' },
  { code: 'void mergeSort(int[] a, int lo, int hi) {\n  if (hi - lo < 2) return;\n  int mid = (lo + hi) / 2;\n  mergeSort(a, lo, mid);\n  mergeSort(a, mid, hi);\n  merge(a, lo, mid, hi);   // O(hi - lo)\n}', ans: 'O(n log n)', why: 'log n levels of halving, O(n) merging work per level.' },
  { code: 'for (int i = 0; i < n; i++) count++;\nfor (int j = 0; j < n; j++) count++;', ans: 'O(n)', why: 'Two loops one AFTER the other: n + n = 2n, constants drop.' },
  { code: 'for (int i = 0; i < 1000; i++)\n  count++;', ans: 'O(1)', why: 'The loop bound is a constant, not n.' },
  { code: '// list is an ArrayList of size n\nlist.add(x);   // at the end', ans: 'O(1)', why: 'Amortised constant: an occasional resize is spread over many adds.' },
  { code: '// list is an ArrayList of size n\nlist.add(0, x);   // at the front', ans: 'O(n)', why: 'Every existing element shifts one place right.' },
  { code: '// list is a LinkedList of size n\nlist.get(n / 2);', ans: 'O(n)', why: 'A linked list must walk node by node to the middle.' },
  { code: '// map is a HashMap with n entries\nmap.get(key);', ans: 'O(1)', why: 'Hashing goes straight to the bucket (average case).' },
  { code: '// set is a TreeSet with n elements\nset.contains(x);', ans: 'O(log n)', why: 'A balanced BST (red-black tree) has height log n.' },
  { code: '// pq is a PriorityQueue (binary heap) of size n\npq.add(x);', ans: 'O(log n)', why: 'Sift-up climbs at most the height of the heap.' },
  { code: '// pq is a PriorityQueue of size n\npq.peek();', ans: 'O(1)', why: 'The minimum is always at the root.' },
  { code: 'for (int i = 0; i < n; i++)\n  for (int j = 0; j < n; j++)\n    for (int k = 0; k < 5; k++)\n      count++;', ans: 'O(n²)', why: 'The inner loop is a constant 5; n × n × 5 is still n².' },
  { code: 'boolean hasDup(int[] a) {\n  for (int i = 0; i < a.length; i++)\n    for (int j = i + 1; j < a.length; j++)\n      if (a[i] == a[j]) return true;\n  return false;\n}', ans: 'O(n²)', why: 'Worst case (no duplicates) compares every pair.' },
  { code: 'void printSubsets(int[] a, int i, List<Integer> cur) {\n  if (i == a.length) { System.out.println(cur); return; }\n  printSubsets(a, i + 1, cur);\n  cur.add(a[i]);\n  printSubsets(a, i + 1, cur);\n  cur.remove(cur.size() - 1);\n}', ans: 'O(2ⁿ)', why: 'There are 2ⁿ subsets, and each is visited once.' },
  { code: 'int power(int b, int n) {\n  if (n == 0) return 1;\n  int half = power(b, n / 2);\n  return n % 2 == 0 ? half * half : half * half * b;\n}', ans: 'O(log n)', why: 'n halves on each call, with a single recursive call.' },
  { code: '// insertion sort on an ALREADY SORTED array of n\nfor (int i = 1; i < n; i++) {\n  int j = i;\n  while (j > 0 && a[j-1] > a[j]) { swap(a, j, j-1); j--; }\n}', ans: 'O(n)', why: 'Best case: the while loop never runs, one pass only.' },
  { code: '// quicksort, pivot = last element, input ALREADY SORTED', ans: 'O(n²)', why: 'Worst case: every partition is n−1 vs 0.' },
  { code: 'String s = "";\nfor (int i = 0; i < n; i++)\n  s += "x";   // Java strings are immutable', ans: 'O(n²)', why: 'Each += copies the whole string: 1 + 2 + … + n characters.' },
  { code: 'StringBuilder sb = new StringBuilder();\nfor (int i = 0; i < n; i++)\n  sb.append("x");', ans: 'O(n)', why: 'append is amortised O(1) — this is why StringBuilder exists.' },
  { code: '// BFS on a graph with V vertices and E edges,\n// adjacency lists  (n = V + E)', ans: 'O(n)', why: 'Each vertex is enqueued once and each edge examined once: O(V + E).' },
  { code: '// build a heap from n elements with bottom-up heapify', ans: 'O(n)', why: 'Most nodes are near the bottom and sift down only a little: the sum is linear.' },
];

const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const BEST_KEY = 'studyos_bigo_best';

export function mount(host, ctx) {
  const { esc } = ctx;
  let timer = null;
  const best = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { return 0; } };

  const intro = () => {
    host.innerHTML = `<div class="sp-panel" style="text-align:center">
      <div style="font-size:15px;margin-bottom:6px">60 seconds. Name the Big-O of each snippet.</div>
      <div class="sp-muted" style="font-size:12px;margin-bottom:12px">Streak record: ${best()}</div>
      <button class="sp-btn primary" data-go>Start</button> <button class="sp-btn" data-untimed>Untimed practice</button></div>`;
    host.querySelector('[data-go]').onclick = () => round(true);
    host.querySelector('[data-untimed]').onclick = () => round(false);
  };

  const round = (timed) => {
    const deck = shuffle(BANK);
    let i = 0, streak = 0, bestStreak = 0, right = 0, left = 60;
    host.innerHTML = `<div class="sp-row" style="margin-bottom:8px"><span class="sp-score" data-t></span><span class="sp-score" data-s style="margin-left:auto"></span></div>
      <div data-q></div>`;
    const tEl = host.querySelector('[data-t]'), sEl = host.querySelector('[data-s]'), qEl = host.querySelector('[data-q]');
    const paintTop = () => { tEl.textContent = timed ? `${left}s` : 'untimed'; sEl.textContent = `streak ${streak} · ${right} right`; };
    const end = () => {
      clearInterval(timer); timer = null;
      if (bestStreak > best()) { try { localStorage.setItem(BEST_KEY, String(bestStreak)); } catch (e) {} }
      qEl.innerHTML = `<div class="sp-panel" style="text-align:center"><div style="font-size:18px;margin-bottom:6px">${right} right · best streak ${bestStreak}</div>
        <button class="sp-btn primary" data-again>Again</button></div>`;
      qEl.querySelector('[data-again]').onclick = () => round(timed);
    };
    const show = () => {
      if (i >= deck.length) return end();
      const it = deck[i];
      qEl.innerHTML = `<div class="sp-code" style="margin-bottom:10px">${esc(it.code)}</div>
        <div class="sp-grid" style="grid-template-columns:repeat(3,1fr)">${OPTIONS.map((o) => `<button class="sp-choice" data-o="${esc(o)}" style="text-align:center">${esc(o)}</button>`).join('')}</div>
        <div data-fb style="margin-top:8px;font-size:13px;min-height:18px"></div>`;
      qEl.querySelectorAll('[data-o]').forEach((b) => {
        b.onclick = () => {
          const ok = b.dataset.o === it.ans;
          ctx.record({ topic: 'Big-O', correct: ok, difficulty: 1 });
          if (ok) { streak++; right++; bestStreak = Math.max(bestStreak, streak); } else streak = 0;
          qEl.querySelectorAll('[data-o]').forEach((x) => { x.disabled = true; if (x.dataset.o === it.ans) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
          qEl.querySelector('[data-fb]').innerHTML = `<span class="${ok ? 'sp-ok' : 'sp-bad'}">${ok ? '✓' : '✗ ' + esc(it.ans) + ' —'}</span> ${esc(it.why)}`;
          paintTop();
          i++;
          setTimeout(() => { if (!timed || timer) show(); }, ok ? 900 : 2200);
        };
      });
    };
    paintTop();
    if (timed) timer = setInterval(() => { left--; paintTop(); if (left <= 0) end(); }, 1000);
    show();
  };
  intro();
  return () => { if (timer) clearInterval(timer); };
}

export default { mount, BANK, OPTIONS };
