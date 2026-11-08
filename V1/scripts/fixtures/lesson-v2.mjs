// v2 lesson fixtures: the spec's reference lesson (TreeNode), and a BST
// search lesson with a walkthrough. Shared by test-lesson-v2.mjs and
// verify-breakdown.mjs. Written the way a chat model answers (optional fields
// left out), not the strict wire shape.

const EX = {
  id: 'ex', kind: 'tree', root: 'n60',
  nodes: [{ id: 'n60', value: '60' }, { id: 'n55', value: '55' }, { id: 'n100', value: '100' },
    { id: 'n45', value: '45' }, { id: 'n57', value: '57' }, { id: 'n67', value: '67' }, { id: 'n107', value: '107' }],
  edges: [{ from: 'n60', to: 'n55', side: 'left' }, { from: 'n60', to: 'n100', side: 'right' },
    { from: 'n55', to: 'n45', side: 'left' }, { from: 'n55', to: 'n57', side: 'right' },
    { from: 'n100', to: 'n67', side: 'left' }, { from: 'n100', to: 'n107', side: 'right' }],
  labels: [{ target: 'n60', text: 'root' }],
};

export const TREENODE = {
  version: 2,
  topicId: '25slide-t2',
  title: 'Representing binary trees with linked TreeNode objects',
  summary: 'A binary tree is stored as linked node objects, each holding a value and left/right references.',
  whyItMatters: 'Every BST operation (search, insert, delete) walks these links. Exams ask you to trace links like root.left.right and to spot missing null checks.',
  prerequisites: ['Linked list Node class', 'Binary tree terminology'],
  estMinutes: 6,
  runningExample: EX,
  steps: [
    { type: 'hook', heading: "Trees don't fit in a line",
      body: 'A list has one *next*. A tree node can have **two** children, so we can\'t store it as a row. Instead, each node points to its children.',
      callouts: [{ kind: 'analogy', text: 'Like folders on your laptop: each folder holds links to the folders inside it, not a flat list of everything.' }] },
    { type: 'diagram', heading: 'One node = value + two arrows',
      diagram: { id: 'nb', kind: 'nodebox', className: 'TreeNode<E>',
        fields: [{ name: 'element', value: '60' }, { name: 'left', value: '→', pointsTo: '55' }, { name: 'right', value: '→', pointsTo: '100' }],
        caption: 'A missing child is stored as null.' } },
    { type: 'concept', heading: 'The example tree', body: 'Here is the tree the rest of this lesson uses. **root** points at 60.',
      diagram: { id: 'ex-c', kind: 'tree', nodes: [], edges: [], highlight: ['n60'] } },
    { type: 'code', heading: 'The TreeNode class',
      code: { language: 'java',
        source: 'class TreeNode<E> {\n  E element;\n  TreeNode<E> left;\n  TreeNode<E> right;\n\n  public TreeNode(E o) {\n    element = o;\n  }\n}',
        annotations: [
          { line: 2, note: 'The value stored in this node.', highlight: ['element'] },
          { line: 3, note: 'Same type as the class: nodes point to nodes.', highlight: ['left', 'nope'] },
          { line: 7, note: 'Only element is set, so left and right start as null: a new node is a leaf.' },
          { line: 99, note: 'out of range' }] } },
    { type: 'check', heading: 'Follow the links',
      check: { format: 'short', prompt: 'In the example tree, what is root.left.right?', answer: '57',
        explanation: 'root is 60 → left is 55 → right of 55 is 57.', diagram: { id: 'ex-q', kind: 'tree', root: 'n60', nodes: [], edges: [] } } },
    { type: 'trap', heading: 'Check null before you step',
      body: '`root.left.right` throws a NullPointerException if `root` or `root.left` is null.',
      callouts: [{ kind: 'exam', text: 'Tracing questions often use an empty tree (root == null). Handle it first.' }] },
    { type: 'check', heading: 'Which child is it?',
      check: { format: 'mcq', prompt: 'What is root.right.left?', options: ['67', '107', '57', 'null'], answer: '67',
        explanation: 'root.right is 100; its left child is 67.' } },
    { type: 'compare', heading: 'List Node vs TreeNode',
      compare: {
        left: { label: 'Linked list Node', code: { language: 'java', source: 'E element;\nNode<E> next;' } },
        right: { label: 'TreeNode', code: { language: 'java', source: 'E element;\nTreeNode<E> left;\nTreeNode<E> right;' } } } },
    { type: 'recap', heading: 'Key takeaways',
      takeaways: [
        'A binary tree is a set of linked nodes, one object per node.',
        'Each node holds element, left and right.',
        'A new TreeNode starts with left = right = null (a leaf).',
        'The tree is reached through root; root == null means an empty tree.',
        'Always null-check a link before reading through it.'] },
  ],
  cheatSheet: {
    bullets: ['Node = element + left + right', 'Missing child = null', 'Access everything from root', 'Null-check before .left/.right'],
    code: { language: 'java', source: 'class TreeNode<E> { E element; TreeNode<E> left, right; }' },
  },
  flashcards: [
    { front: 'What three fields does a TreeNode have?', back: 'element, left, right', tag: 'definition' },
    { front: 'After new TreeNode<>(5), what are left and right?', back: 'null: the node starts as a leaf', tag: 'code' },
    { front: 'What does root == null mean?', back: 'The tree is empty', tag: 'definition' },
    { front: 'Why can root.left.right crash?', back: 'NullPointerException if root or root.left is null', tag: 'trap' },
  ],
};

export const BST_SEARCH = {
  version: 2,
  title: 'Searching a binary search tree',
  summary: 'Search compares the key with each node and goes left or right, never visiting the other subtree.',
  whyItMatters: 'Search is the core of every BST operation. Exams ask for the path a search takes and its worst case.',
  prerequisites: ['TreeNode'],
  estMinutes: 5,
  runningExample: EX,
  steps: [
    { type: 'hook', heading: 'Halve the work each step', body: 'In a BST, smaller keys live to the **left**, larger to the **right**. One comparison rules out a whole subtree.',
      diagram: { id: 'h', kind: 'tree', nodes: [] } },
    { type: 'walkthrough', heading: 'Searching for 57',
      body: 'Each frame is one comparison.',
      diagram: { id: 'w', kind: 'tree', nodes: [],
        frames: [
          { highlight: ['n60'], labels: [{ target: 'n60', text: 'current' }], note: 'Start at root: 57 < 60 → go left' },
          { highlight: ['n55'], labels: [{ target: 'n55', text: 'current' }], note: '57 > 55 → go right' },
          { highlight: ['n57'], labels: [{ target: 'n57', text: 'found' }], note: '57 == 57 → found' }] } },
    { type: 'check', heading: 'Predict the path', check: { format: 'order', prompt: 'Put the nodes a search for 67 visits in order.',
      options: ['100', '60', '67'], answer: ['60', '100', '67'], explanation: '67 > 60 → right to 100; 67 < 100 → left to 67.' } },
    { type: 'code', heading: 'search in Java',
      code: { language: 'java', source: 'boolean search(E e) {\n  TreeNode<E> cur = root;\n  while (cur != null) {\n    int c = e.compareTo(cur.element);\n    if (c < 0) cur = cur.left;\n    else if (c > 0) cur = cur.right;\n    else return true;\n  }\n  return false;\n}',
        annotations: [{ line: 3, note: 'Stop when we fall off the tree: not found.' }, { line: 5, note: 'Smaller → left.', highlight: ['n55'] }] } },
    { type: 'trap', heading: 'A skewed tree is a list', body: 'Insert 1, 2, 3, 4 in order and every node has only a right child. Search is then **O(n)**, not O(log n).',
      diagram: { id: 'sk', kind: 'linkedlist', nodes: [{ id: 'a', value: '1' }, { id: 'b', value: '2' }, { id: 'c', value: '3' }],
        links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: null }], pointers: [{ name: 'root', target: 'a' }] } },
    { type: 'practice', heading: 'Fill the blank', body: 'Searching 107: 107 > 60 → right to 100; 107 > 100 → ___.',
      check: { format: 'fill-blank', prompt: '107 > 100 → go ___', answer: ['right', 'right to 107'], explanation: 'Larger keys go right; 107 is 100\'s right child.' } },
    { type: 'recap', heading: 'Key takeaways', takeaways: ['Compare, then go left (smaller) or right (larger).', 'Not found when you reach null.', 'O(h): O(log n) balanced, O(n) skewed.'] },
  ],
  cheatSheet: { bullets: ['smaller → left, larger → right', 'null → not found'],
    complexities: [{ op: 'search', best: 'O(1)', avg: 'O(log n)', worst: 'O(n)' }] },
  flashcards: [
    { front: 'Worst-case time of BST search?', back: 'O(n), for a skewed tree', tag: 'complexity' },
    { front: 'When does BST search stop with "not found"?', back: 'When the current reference becomes null', tag: 'trap' },
  ],
};
