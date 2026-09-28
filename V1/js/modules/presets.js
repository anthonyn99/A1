/* ============================================================================
 * StudyOS — study-kit style presets  (engagement upgrade 1.2)
 * ============================================================================
 * Seeded ONCE per class into a prompts module named "Study Kit Presets", where
 * they are ordinary prompts: editable, removable, reorderable. The first line
 * ("# Name") is the display name in the Run sheet.
 *
 * These set STYLE only. The output shape (JSON for cards and quiz, "## Slide N"
 * sections for the rewrite) is appended by the bridge, so no edit here can
 * break parsing.
 * ------------------------------------------------------------------------- */

export const MODULE_NAME = 'Study Kit Presets';

// Only {{class}}: an unresolved variable stays LITERAL in the sent prompt
// (prompts.interpolate), and not every class has a course code.
const COMMON = `Course: {{class}}. I am a university CS student preparing for an exam. Use the attached lecture as the source of truth: do not invent material it does not cover, and keep its notation and terminology.`;

export const PRESETS = [
  `# Standard
${COMMON}

Rewrite the material so it is clearer than the slides: full sentences where the slides use fragments, every term defined the first time it appears, and the reasoning behind each rule rather than just the rule.`,

  `# Explain like I know Python
${COMMON}

I am fluent in Python and newer to everything else. Explain each idea by connecting it to the Python equivalent I already know (lists, dicts, classes, generators, sets, list comprehensions), and point out exactly where the analogy breaks. When code appears, show the Python version first and then the course's language.`,

  `# Analogy-heavy
${COMMON}

Give every abstract idea a concrete, everyday analogy (queues at a coffee shop, library catalogs, filing cabinets) and then state precisely how the real concept differs. Keep the analogies short; the precise definition always follows.`,

  `# Exam-focused
${COMMON}

Optimise for the exam. Lead with what is most likely to be tested, call out classic trick questions and common mistakes, show how each concept is typically asked about, and flag anything that must be memorised verbatim (definitions, complexities, rules).`,

  `# Worked-examples-first
${COMMON}

Teach through examples. For each concept, start with a small fully worked example (trace every step, show intermediate states or tables), then generalise to the rule, then give one more example with a twist.`,
];

export default { MODULE_NAME, PRESETS };
