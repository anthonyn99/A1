/* ============================================================================
 * StudyOS drills — Python → Java translation
 * ============================================================================
 * She knows Python; the course is in Java. Each task: a Python snippet,
 * sample input/output, and a rubric. Her Java is graded by the local bridge's
 * `grade` mode (one short Claude ask, rubric + sample I/O, JSON back) — there
 * is no Java runtime in a browser to run it for real.
 *
 * Without the bridge (phone, or the bridge is off) it degrades to self-check:
 * the rubric and a model answer, and she marks herself. That still counts as
 * practice and still feeds weak spots.
 * ------------------------------------------------------------------------- */

export const TASKS = [
  { topic: 'Loops & arrays', title: 'Sum of evens',
    py: 'def sum_evens(nums):\n    total = 0\n    for n in nums:\n        if n % 2 == 0:\n            total += n\n    return total',
    io: 'sumEvens(new int[]{1, 2, 3, 4, 6}) → 12',
    rubric: ['static method returning int', 'takes an int[] (or List<Integer>)', 'enhanced for or index loop', 'uses % 2 == 0', 'correct result on the sample'],
    model: 'public static int sumEvens(int[] nums) {\n    int total = 0;\n    for (int n : nums) {\n        if (n % 2 == 0) total += n;\n    }\n    return total;\n}' },
  { topic: 'Strings', title: 'Reverse a string',
    py: 'def reverse(s):\n    return s[::-1]',
    io: 'reverse("stack") → "kcats"',
    rubric: ['returns a String', 'no slicing syntax (Java has none)', 'StringBuilder.reverse() or a loop', 'correct on the sample'],
    model: 'public static String reverse(String s) {\n    return new StringBuilder(s).reverse().toString();\n}' },
  { topic: 'Collections', title: 'Word counts',
    py: 'def counts(words):\n    d = {}\n    for w in words:\n        d[w] = d.get(w, 0) + 1\n    return d',
    io: 'counts(List.of("a", "b", "a")) → {a=2, b=1}',
    rubric: ['returns Map<String, Integer>', 'uses HashMap', 'getOrDefault or merge', 'generics written correctly'],
    model: 'public static Map<String, Integer> counts(List<String> words) {\n    Map<String, Integer> d = new HashMap<>();\n    for (String w : words) {\n        d.put(w, d.getOrDefault(w, 0) + 1);\n    }\n    return d;\n}' },
  { topic: 'Classes', title: 'A Point class',
    py: 'class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n    def dist2(self, other):\n        return (self.x - other.x)**2 + (self.y - other.y)**2',
    io: 'new Point(0, 0).dist2(new Point(3, 4)) → 25',
    rubric: ['private fields with types', 'constructor with this.x = x', 'instance method dist2(Point other)', 'no ** operator (use multiplication or Math.pow)'],
    model: 'public class Point {\n    private final int x, y;\n    public Point(int x, int y) { this.x = x; this.y = y; }\n    public int dist2(Point o) {\n        int dx = x - o.x, dy = y - o.y;\n        return dx * dx + dy * dy;\n    }\n}' },
  { topic: 'Recursion', title: 'Recursive max',
    py: 'def rmax(nums, i=0):\n    if i == len(nums) - 1:\n        return nums[i]\n    return max(nums[i], rmax(nums, i + 1))',
    io: 'rmax(new int[]{3, 9, 2}, 0) → 9',
    rubric: ['base case at the last index', 'recursive call with i + 1', 'Math.max', 'no default parameters (overload or pass 0)'],
    model: 'public static int rmax(int[] nums, int i) {\n    if (i == nums.length - 1) return nums[i];\n    return Math.max(nums[i], rmax(nums, i + 1));\n}' },
  { topic: 'Stacks', title: 'Balanced brackets',
    py: 'def balanced(s):\n    stack = []\n    pairs = {")": "(", "]": "["}\n    for ch in s:\n        if ch in "([":\n            stack.append(ch)\n        elif ch in ")]":\n            if not stack or stack.pop() != pairs[ch]:\n                return False\n    return not stack',
    io: 'balanced("([])") → true;  balanced("(]") → false',
    rubric: ['Deque<Character> / ArrayDeque used as a stack', 'push / pop / isEmpty', 'char comparisons with ==', 'returns boolean'],
    model: 'public static boolean balanced(String s) {\n    Deque<Character> st = new ArrayDeque<>();\n    for (char c : s.toCharArray()) {\n        if (c == \'(\' || c == \'[\') st.push(c);\n        else if (c == \')\' || c == \']\') {\n            char want = c == \')\' ? \'(\' : \'[\';\n            if (st.isEmpty() || st.pop() != want) return false;\n        }\n    }\n    return st.isEmpty();\n}' },
  { topic: 'Generics', title: 'Generic pair swap',
    py: 'def swap(pair):\n    a, b = pair\n    return (b, a)',
    io: 'swap(new Pair<>("x", 1)) → Pair(1, "x")',
    rubric: ['a generic class Pair<A, B>', 'a generic method <A, B> Pair<B, A> swap(Pair<A, B> p)', 'no tuple syntax', 'types line up'],
    model: 'record Pair<A, B>(A first, B second) {}\n\npublic static <A, B> Pair<B, A> swap(Pair<A, B> p) {\n    return new Pair<>(p.second(), p.first());\n}' },
];

export function gradePrompt(task, java) {
  return `You are grading a CS student's Java translation of a Python snippet.

PYTHON:
${task.py}

SAMPLE INPUT/OUTPUT (the Java must behave like this):
${task.io}

RUBRIC:
${task.rubric.map((r) => '- ' + r).join('\n')}

STUDENT'S JAVA:
${java}`;
}

export function mount(host, ctx) {
  const { esc } = ctx;
  const P = () => window.SOS && window.SOS.pipeline;
  const canGrade = () => !!(P() && P().enabled() && P().grade);
  let i = 0;
  const show = () => {
    const t = TASKS[(i + TASKS.length) % TASKS.length];
    host.innerHTML = `
      <div class="sp-row" style="margin-bottom:6px"><span class="sp-muted" style="font-family:var(--mono);font-size:11px">${esc(t.topic)} · ${((i % TASKS.length) + TASKS.length) % TASKS.length + 1}/${TASKS.length}</span>
        <span style="margin-left:auto" class="sp-row"><button class="sp-btn" data-prev>‹</button><button class="sp-btn" data-next>›</button></span></div>
      <div class="sp-panel"><b>${esc(t.title)}</b><div class="sp-code" style="margin-top:8px">${esc(t.py)}</div>
        <div class="sp-muted" style="font-size:12px;margin-top:6px">Sample: <code>${esc(t.io)}</code></div></div>
      <textarea class="sp-textarea" data-java spellcheck="false" placeholder="Write the Java here" style="min-height:160px"></textarea>
      <div class="sp-row" style="margin-top:8px">
        <button class="sp-btn primary" data-grade>${canGrade() ? 'Grade with Claude' : 'Check myself'}</button>
        <button class="sp-btn" data-model>Show a model answer</button>
        <span class="sp-muted" style="font-size:11px;font-family:var(--mono)">${canGrade() ? 'uses 1 Claude message via the desktop bridge' : 'grading needs the desktop bridge — self-check for now'}</span>
      </div>
      <div data-fb style="margin-top:10px"></div>`;
    const fb = host.querySelector('[data-fb]');
    host.querySelector('[data-prev]').onclick = () => { i--; show(); };
    host.querySelector('[data-next]').onclick = () => { i++; show(); };
    host.querySelector('[data-model]').onclick = () => {
      fb.innerHTML = `<div class="sp-muted" style="font-size:12px">One good answer:</div><div class="sp-code">${esc(t.model)}</div>`;
    };
    const selfCheck = () => {
      fb.innerHTML = `<div class="sp-panel"><div style="margin-bottom:6px">Check your code against the rubric:</div>
        ${t.rubric.map((r, k) => `<label style="display:block;font-size:13px;margin:4px 0"><input type="checkbox" data-r="${k}"> ${esc(r)}</label>`).join('')}
        <div class="sp-code" style="margin-top:8px">${esc(t.model)}</div>
        <button class="sp-btn primary" data-done style="margin-top:8px">Done</button></div>`;
      fb.querySelector('[data-done]').onclick = () => {
        const met = fb.querySelectorAll('[data-r]:checked').length;
        const partial = met / t.rubric.length;
        ctx.record({ topic: 'Java: ' + t.topic, correct: partial === 1, partial, difficulty: 3 });
        fb.innerHTML = `<div class="${partial === 1 ? 'sp-ok' : 'sp-muted'}">${met}/${t.rubric.length} rubric points. <button class="sp-btn" data-go>Next task</button></div>`;
        fb.querySelector('[data-go]').onclick = () => { i++; show(); };
      };
    };
    host.querySelector('[data-grade]').onclick = async () => {
      const java = host.querySelector('[data-java]').value.trim();
      if (!java) { ctx.toast('ℹ️', 'Write some Java first'); return; }
      if (!canGrade()) return selfCheck();
      const btn = host.querySelector('[data-grade]');
      btn.disabled = true;
      fb.innerHTML = '<div class="sp-muted">Grading… (the bridge opens Claude in the background; ~30–60 s)</div>';
      try {
        const g = await P().grade({ kind: 'java', prompt: gradePrompt(t, java), classId: ctx.classId });
        const ok = (g.score || 0) >= 80;
        ctx.record({ topic: 'Java: ' + t.topic, correct: ok, partial: (g.score || 0) / 100, difficulty: 3 });
        fb.innerHTML = `<div class="sp-panel"><div class="${ok ? 'sp-ok' : 'sp-bad'}" style="font-size:16px;margin-bottom:6px">${g.score == null ? '?' : g.score}/100</div>
          ${(g.passes || []).map((x) => `<div style="font-size:13px">✓ ${esc(x)}</div>`).join('')}
          ${(g.issues || []).map((x) => `<div style="font-size:13px" class="sp-bad">✗ ${esc(x)}</div>`).join('')}
          <button class="sp-btn primary" data-go style="margin-top:8px">Next task</button></div>`;
        fb.querySelector('[data-go]').onclick = () => { i++; show(); };
      } catch (e) {
        fb.innerHTML = `<div class="sp-bad" style="font-size:13px">Could not grade: ${esc(e.message)}</div>`;
        btn.disabled = false;
        selfCheck();
      }
    };
  };
  show();
  return null;
}

export default { mount, TASKS, gradePrompt };
