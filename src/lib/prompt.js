/* Blue Pencil - prompt construction and the JSON schema handed to Ollama. */
(function (root) {
  'use strict';

  // Ollama structured outputs: this schema is passed as `format`.
  const EDIT_SCHEMA = {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            before: { type: 'string' },
            after: { type: 'string' },
            category: {
              type: 'string',
              enum: ['spelling', 'grammar', 'punctuation', 'style', 'clarity']
            },
            reason: { type: 'string' }
          },
          required: ['before', 'after', 'category', 'reason']
        }
      }
    },
    required: ['edits']
  };

  /* Rewrites are constrained by a schema too. Without one, a reasoning model
     will happily narrate its plan before answering, and that narration ends up
     in the user's text box. */
  const REWRITE_SCHEMA = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  };

  const DIALECT_NAMES = {
    'en-US': 'American English',
    'en-GB': 'British English',
    'en-AU': 'Australian English',
    'en-CA': 'Canadian English'
  };

  function activeCategories(settings) {
    const cats = settings.categories || {};
    return Object.keys(cats).filter(function (key) { return cats[key]; });
  }

  function buildCheckSystem(settings) {
    const cats = activeCategories(settings);
    const lines = [
      'You are Blue Pencil, a meticulous proofreader. You are given the raw contents of a text box a person is typing into. You return a list of small, surgical edits.',
      '',
      'Hard rules:',
      '1. "before" MUST be copied verbatim from the text, character for character, including capitalization and punctuation. Never paraphrase it. If you cannot copy it exactly, omit the edit.',
      '2. Keep "before" short - normally one to six words. Include just enough surrounding words to make it unique in the text.',
      '3. "after" is the corrected replacement for that exact span, and must differ from "before".',
      '4. Report only clear, defensible problems. If the text is already correct, return {"edits": []}. An empty list is a good answer.',
      '5. Preserve the voice, meaning, formatting and language of the author. Never translate. Never add or remove whole sentences.',
      '6. Leave code, URLs, email addresses, file paths, @mentions, #hashtags, emoji and text inside backticks untouched.',
      '7. Assume the text may be an unfinished fragment. Do not flag a missing final period, and do not complete the thought.',
      '8. Edits must not overlap each other.',
      '',
      'Allowed categories: ' + (cats.length ? cats.join(', ') : 'spelling, grammar, punctuation') + '.',
      'Only return edits belonging to those categories.'
    ];

    if (!settings.categories || !settings.categories.style) {
      lines.push('Do not suggest stylistic rewordings.');
    }
    if (!settings.categories || !settings.categories.clarity) {
      lines.push('Do not suggest clarity rewrites.');
    }
    if (settings.dialect && settings.dialect !== 'auto' && DIALECT_NAMES[settings.dialect]) {
      lines.push('Spelling conventions: ' + DIALECT_NAMES[settings.dialect] + '.');
    }
    if (settings.customInstructions && settings.customInstructions.trim()) {
      lines.push('', 'Additional instructions from the author (these override the guidance above):', settings.customInstructions.trim());
    }

    lines.push('', 'Reply with JSON only: {"edits": [{"before": "...", "after": "...", "category": "...", "reason": "..."}]}');
    lines.push('"reason" is one short sentence, at most 12 words, addressed to the author.');
    return lines.join('\n');
  }

  const FEWSHOT_INPUT = 'i think this are a greate idea, but we should of tested it first';
  const FEWSHOT_OUTPUT = JSON.stringify({
    edits: [
      { before: 'i think', after: 'I think', category: 'grammar', reason: 'The pronoun "I" is always capitalized.' },
      { before: 'this are', after: 'this is', category: 'grammar', reason: 'Subject and verb do not agree.' },
      { before: 'greate', after: 'great', category: 'spelling', reason: 'Misspelling.' },
      { before: 'should of tested', after: 'should have tested', category: 'grammar', reason: 'Use "should have", never "should of".' }
    ]
  });

  function wrap(text) {
    return 'Text box contents:\n<<<TEXT\n' + text + '\nTEXT>>>';
  }

  function buildCheckMessages(text, settings) {
    return [
      { role: 'system', content: buildCheckSystem(settings) },
      { role: 'user', content: wrap(FEWSHOT_INPUT) },
      { role: 'assistant', content: FEWSHOT_OUTPUT },
      { role: 'user', content: wrap('The deployment finished at 3pm and the dashboard looks fine.') },
      { role: 'assistant', content: '{"edits": []}' },
      { role: 'user', content: wrap(text) }
    ];
  }

  function buildRewriteMessages(text, instruction, settings) {
    const lines = [
      'You are Blue Pencil, a careful editor. Rewrite the text the author gives you according to the instruction.',
      '',
      'Rules:',
      '- Reply with JSON only: {"text": "the rewritten text"}.',
      '- "text" holds the rewrite and nothing else: no preamble, no explanation of what you changed, no surrounding quotation marks, no markdown code fences.',
      '- Keep the language of the author. Never translate.',
      '- Preserve line breaks, lists, markdown, code, URLs and @mentions.',
      '- Do not invent facts, names, numbers or commitments that are not already there.',
      '',
      'Instruction: ' + instruction
    ];
    if (settings.dialect && settings.dialect !== 'auto' && DIALECT_NAMES[settings.dialect]) {
      lines.push('Spelling conventions: ' + DIALECT_NAMES[settings.dialect] + '.');
    }
    if (settings.customInstructions && settings.customInstructions.trim()) {
      lines.push('', 'Standing instructions from the author:', settings.customInstructions.trim());
    }
    return [
      { role: 'system', content: lines.join('\n') },
      { role: 'user', content: wrap(text) }
    ];
  }

  root.BP = root.BP || {};
  root.BP.EDIT_SCHEMA = EDIT_SCHEMA;
  root.BP.REWRITE_SCHEMA = REWRITE_SCHEMA;

  root.BP.buildCheckMessages = buildCheckMessages;
  root.BP.buildRewriteMessages = buildRewriteMessages;
})(typeof self !== 'undefined' ? self : this);
