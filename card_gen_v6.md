- Follow my instruction block exactly.
- Do not deviate.
- Do not approximate.
- Do not simplify.
- If any part of the output does not comply with the rules, correct it before presenting the final output.

These cards are designed to fully replace the source study guide. Every piece of clinical information present in the source must be accounted for in the card output without exception. No detail, qualifier, mechanism, alternate name, or clinical nuance may be omitted on the grounds that it is secondary or not directly testable. The card deck must be complete enough that a student who studies only these cards has access to every piece of information contained in the original study guide, framed in a way that prepares them for EOR exam performance.

NOTE: Instructional headings in this block are organizational only and must never appear in the output.

When rules conflict, apply them in the following priority order:

1. Content Integrity and Clinical Relevance Rules
2. Structural Orientation Rules
3. Cloze Construction Rules
4. Language and Formatting Rules

Medical accuracy and contextual clarity always take precedence over cloze formatting.

---

## Output Format and Markup Rules

- Output every card in the exact 3-field pipe-delimited format, one card per line:

  `number|card text|additional context (optional)`

- The first field is the card number.
- The second field (between the first and second pipe) is the card text.
- The third field (after the second pipe) is the additional context field; leave it empty when not applicable.
- Do not add any additional fields, columns, or pipes beyond these three.
- All formatting and emphasis in the output must use HTML tags only.
- Markdown is forbidden anywhere in the output without exception: do not use ** or * for bold or emphasis, do not use # for headings, and do not use backticks or any other markdown syntax.
- Use <b>...</b> for bold and the specified blue <span> wrapper for clozes.
- Any markdown-style emphasis is a formatting error and must be corrected to its HTML equivalent before output.

---

## Source Conversion Rules

- When working from images (including tables, diagrams, flowcharts, or bullet hierarchies), first convert the visual layout into structured textual form while preserving all original medical content, relationships, and hierarchy exactly, without reproducing sentence-level phrasing verbatim.
- Interpret columns, rows, and spatial groupings as hierarchical or relational structure.
- Treat table headers as headings, row labels as subjects, and cell contents as dependent modifiers.
- Do not infer relationships beyond those visually indicated.
- Once converted to structured text, apply all granularity, bullet, and cloze rules as written.

---

## Granularity and Mechanism Rules

- Use mechanism-cluster granularity.
- Split distinct mechanistic links, but do not atomize symptom lists, timing sequences within a single-phase description, or tightly related manifestations arising from the same causal pathway.
- Split compound sentences into separate cards when they contain distinct mechanisms or testable concepts.
- Create one card per independently testable mechanism unit and bundle tightly linked targets into the same card when they belong to the same causal chain.
- Do not combine unrelated rows.
- Do not omit any mechanisms.
- A tightly linked clinical set is defined as elements that are commonly tested together as a single unit (e.g., symptom clusters, first-line management groups, or classic triads).
- Do not split these elements into separate cards unless each element represents an independently testable concept in isolation.

When a list of items appears under a shared heading across all source formats including bulleted lists, numbered lists, table rows, and enumerated items embedded in prose, apply the following decision rule.

- When all items are bare labels without attached explanation content, bundle all items into a single card as a tightly linked clinical set using the same cloze index.
- When two or fewer items carry short qualifiers of three words or fewer and the combined card content produces no more than three cloze targets and remains scannable in a single pass, bundling is permitted.
- When items carry explanation content defined as any attached clause, sentence, sub-bullet, or qualifier of four or more words, apply the sibling card pattern.
- When source content is structured as parent bullets with child sub-bullets, the sub-bullets constitute explanation content for their parent bullet regardless of whether the explanation appears inline or as a separate indented level.
- Evaluate each parent bullet together with its sub-bullets when determining whether the sibling card pattern applies.
- The sibling card pattern applies only when items share the same conceptual category, meaning they are all treatment elements, all physical exam findings, all symptoms, all diagnostic steps, or all members of another single defined category.
- Two sentences appearing in the same bullet or paragraph do not qualify as parallel list members unless they belong to the same conceptual category.
- A standalone clinical finding, sign, named test result, or complication belongs to a different conceptual category than a treatment list and must always be generated as an independent card with a blank additional context field regardless of its proximity to other content in the source.
- Under the sibling card pattern, generate one card per item.
- Every item in the set must appear as the active cloze target on its own dedicated card.
- No item may appear only in the footer without also having its own active card in the sibling set.
- The complete sibling set must contain exactly as many cards as there are items in the source list.
- When a single sentence contains multiple distinct items connected by logical connectors such as and or or, each item must be counted as a separate member of the sibling set and must receive its own dedicated active card.
- Do not treat a compound sentence as a single sibling set item.
- The active card tests that item and its full explanation as the primary cloze target.
- All remaining items in the set with their full explanations exactly as present in the source are carried in the additional context field of every sibling card.
- This pattern applies universally to any list type under any heading regardless of content category, including symptoms, findings, risk factors, complications, diagnostic criteria, and management steps.
- When the source format is a table, treat each row with explanation content as an item and apply the sibling card pattern across rows.
- When enumerated items are embedded in flowing prose, identify each discrete item and explanation and apply the same decision rule.

Before applying the sibling card pattern to any list, apply the following test:

- Could each item on this list be the subject of its own standalone EOR question without reference to the other items?
- If yes, apply the sibling card pattern.
- If no, bundle into one card.
- Named clinical pearls, classic triads, diagnostic criteria sets, and consequence clusters that are memorized and tested as complete units must always be bundled regardless of the number of items.

---

## Structural Orientation Rules

- When bullets are fragments under a heading, treat the heading as the subject and incorporate it into each bullet-derived card using only terms already present in the original text.
- When sub-bullets are present, treat them as dependent on the nearest parent bullet; bundle sub-bullets with the parent when they are examples or qualifiers, and split sub-bullets into separate cards when each sub-bullet contains an independently testable mechanism.
- When sub-bullets are derived from a parent bullet that functions as a structural orientation label, incorporate the parent label into the card when it contributes to the meaning, categorization, or testing context.
- When a bullet hierarchy includes subcategory labels, incorporate the subcategory label into each derived card as a structural orientation label when it defines the type of information being tested.
- When structural orientation labels (including subcategory labels) are incorporated into a card, they must be preserved exactly and bolded only if they are non-branded, non-source-identifying labels.
- Do not preserve or bold any source names, platform names, or third-party identifiers.
- When a heading represents exam-relevant content, preserve it and treat it as a structural orientation label only if it is non-branded and non-source-identifying.
- If a heading contains source-identifying language, remove it and retain only the underlying medical content.
- When incorporating a heading into fragment bullets, preserve grammatical and semantic relationships; descriptors must modify the appropriate entity and must not be converted into modifiers of the disease if they originally describe the patient, condition context, or case type.
- When abbreviations represent structural orientation labels, expand them and preserve them as structural orientation labels.
- When extracting or generating a card from a fragment, modifier, or partial sentence (including timing, duration, qualifiers, or conditions), the card must explicitly include its parent concept (e.g., diagnosis, management, or intervention) to remain fully interpretable in isolation.

Additional context field:

- The additional context field must only include elements derived from the same original sentence, bullet group, or structured list as the primary card.
- Do not include information from other sentences, sections, or conceptual groupings, even if clinically related.
- The additional context field may be formatted for clarity using simple grouping (e.g., bullet points or labeled lists such as "Other indications") but must preserve the original wording and structure of the source content without introducing new phrasing or interpretation.
- When applicable, the additional context field must be presented as a clearly labeled reinforcement field (e.g., "Other causes," "Other symptoms," "Other imaging indications," "Other treatment elements") rather than as an unlabeled fragment.

Sibling card footer:

- When the sibling card pattern is applied, the additional context field of every card in the sibling set must contain a labeled footer presenting all other items in the set with their full explanations exactly as present in the source, without summarizing, abbreviating, or omitting any content regardless of length.
- The footer label must be derived from the parent heading and must reflect the categorical identity of the list using language already present in the source (e.g., "Other symptoms:", "Other findings:", "Other risk factors:", "Other treatment elements:", "Other diagnostic criteria:").
- Do not introduce label language that is not derivable from the source.
- When the source format is a bulleted list, preserve the list structure of the footer items.
- When the source format is a table, preserve the row and column relationships of the footer items.
- When the source format is flowing prose with embedded enumeration, present the footer items as a labeled list derived from the prose structure.
- The parent heading must appear as an explicit anchor in the stem of every sibling card.
- When a sibling set is derived from a sub-heading that itself falls under a higher parent heading, both the sub-heading and the higher parent heading must be present in the card stem when both contribute to the testable meaning of the card.

---

## Content Transformation Rules

- Preserve all medical facts, relationships, mechanisms, and qualifiers exactly.
- Do not reproduce sentences or recognizable proprietary phrasing.
- Re-express all content using neutral, standardized clinical language while maintaining original meaning, level of detail, and exam relevance.
- Maintain clear sentence-based structure.
- Do not simplify, omit, or generalize medical content.
- Do not expand, reinterpret, or alter physiological meaning.
- Do not omit or remove alternate names, synonyms, or equivalent terms explicitly provided in the source (e.g., "also called," "also known as").
- When multiple equivalent terms are given for the same concept, preserve them within the same card when they represent the same testable entity.
- Do not infer, reinterpret, combine, or reframe information beyond what is explicitly stated in the source.
- All extracted content must preserve the complete clinical meaning, detail, exam relevance, and contextual relationships of the source.
- Rewording is expected and required to produce clean neutral clinical language that does not reproduce source phrasing verbatim.
- Rewording must never reduce clinical context, strip qualifying information, or convert a contextual knowledge statement into an isolated fact.
- A card must contain enough surrounding clinical context that a student can study from it meaningfully, not merely recall a single stripped fact.
- Accurate cards preserve clinical meaning, contextual relationships, and exam relevance, not source phrasing.
- Do not alter medical facts, add interpretation, change mechanisms, or introduce emphasis not present in the source.
- When a card contains a list of items whose order carries no clinically significant sequence, the order of listed items may be reshuffled to further separate card language from source phrasing.
- Do not reshuffle items in any list where order reflects clinical priority, pathophysiological sequence, or graded severity.
- For prose source sentences, rewording must produce genuinely different sentence architecture through word order variation, clause restructuring, or sentence splitting such that the card cannot be reduced to the source sentence by simple word replacement.
- For bullet or fragment source content, conversion into a complete clinical sentence with the parent heading as anchor constitutes sufficient separation from the source.

---

## Cloze Construction Rules

- Cloze only the independently testable element or elements within the mechanism unit and do not cloze entire sentences unless the whole sentence is the testable concept.
- Keep causal and directional verbs visible as contextual anchors unless the verb itself is the independently testable element.
- When multiple blanks belong to the same mechanism unit on the same card, use the same cloze index for those blanks.
- Cloze any single word or short phrase that represents an independently testable clinical concept, including but not limited to anatomical structures, physiological terms, classification terms, diagnostic findings, directional descriptors, and clinical modifiers that define the type, nature, or category of a condition.
- Avoid clozing filler words, prepositions, conjunctions, and non-clinical connecting language.
- Minimal grammatical restructuring is permitted only when necessary to form a complete standalone sentence, without altering meaning, terminology, or category.
- Each card must be fully understandable in isolation.
- If any wording depends on prior context to make sense, replace the dependent wording with its explicit referent using only terms already present in the original text, without adding new information or changing meaning.
- Each card must test a single primary recall target.
- Multiple elements may be clozed together only when they form a tightly linked clinical set that is commonly tested as a group (e.g., symptom clusters or first-line management).
- Do not include logical connectors (e.g., and, or, with, without) inside cloze deletions; leave connectors visible to preserve readability and reduce cognitive load.
- When a cloze includes multiple elements that are part of the same clinical set and are connected by logical connectors (e.g., "and," "or"), each element must be clozed separately using the same cloze index, with the connector remaining outside the cloze.
- Each card must retain a visible clinical anchor.
- The subject of the card is defined as any word, phrase, or concept that functions as the primary anchor of the card, meaning it is the thing being described, tested, or elaborated upon in the card stem.
- The subject must never be clozed regardless of its category, position, or form in the source.
- If removing a term would leave the card without a clear reference point for what is being studied, that term is the subject and must remain visible.
- Only the target recall element may be clozed.
- When the primary recall target of a card is also the governing concept of the card stem, it must be clozed.
- The condition or diagnosis that provides clinical context for the card remains visible and unclozed as the true anchor.
- Do not allow the subject anchor rule to strictly protect a term from clozing when that term is itself the testable element the student is expected to recall.
- When clozing a named clinical entity, cloze only the distinguishing name and leave the category word visible as a contextual hint.
- The category word is defined as any word that identifies the type of entity being named, such that its presence gives the student a meaningful clue about what is being recalled without revealing the answer itself.
- Do not cloze the category word.
- When clozing a multi-word clinical phrase, cloze only the specific identifying term that represents the independently testable recall target and leave the descriptor, qualifier, or category word visible as a contextual hint.
- The visible word must narrow the answer space meaningfully without revealing the answer.
- Single word clinical terms that are independently testable are clozed in full.
- Do not apply partial cloze to single word terms.

---

## Language and Abbreviation Rules

- Abbreviations may be expanded only when the expansion is a direct and exact equivalent of the original term; do not substitute or reinterpret terms in a way that changes meaning, category, or clinical context.
- Do not abbreviate common English words (e.g., years, with, without, before, after).
- Use standard medical abbreviations where appropriate.
- On first occurrence, present the full term followed by the abbreviation in parentheses; subsequent uses may use the abbreviation alone.
- Universally recognized medical abbreviations (e.g., CBC, BMP, ECG, EKG, CT, MRI) may be used without expansion.
- Do not introduce nonstandard, ambiguous, or uncommon abbreviations.

---

## Content Integrity and Style Rules

- Do not change the fundamental medical fact being tested.
- Do not omit any content or mechanisms.
- Before generating any cards, read the entire source content and identify every discrete line, statement, bullet, sub-bullet, pearl, mnemonic, urgency marker, and standalone phrase.
- Every identified element must map to at least one card in the output.
- After generating all cards, verify that no source line was skipped.
- Short standalone statements such as time equals nerves, must be recognized immediately, or similar high yield phrases must each generate their own dedicated card and must never be omitted because they appear brief or do not fit a standard list or sentence structure.
- Do not add information beyond what is explicitly present unless required for clarity and it is a direct, exact equivalent.
- Do not add explanatory framing phrases that describe the type or category of clinical information being presented, such as "is a hallmark presentation feature," "is a key clinical finding," "affects clinical function," or similar constructions.
- These phrases are not present in the source and add length without clinical value.
- Express the clinical fact directly without labeling what kind of fact it is.
- Do not make cards longer than necessary; maintain maximal concision while preserving full meaning and exam-relevant detail.
- Do not use em dashes (—) or double hyphens (--) anywhere in the output.
- Do not cloze elements that are explicitly stated in the card stem unless they are the primary testable concept.
- Avoid testing recognition of the diagnosis when the diagnosis is already given; instead, test distinguishing features, mechanisms, management, or decision-making points.
- When applicable, cards should reflect clinical decision-making patterns (e.g., indications, contraindications, next steps, thresholds, or red-flag trigger rather than isolated facts.

Before outputting any cards, verify that every row fully complies with all formatting and content rules in this block. Specifically confirm that:

1. the output uses the exact 3-field pipe format (number|card text|additional context), with no extra fields or pipes,
2. the cloze preserves a visible anchor and does not over-hide the prompt,
3. the additional context field contains only the remaining elements from the same original sentence, bullet group, or structured list and is blank when not applicable.

If any row fails any requirement, revise it before output.

---

## Source Attribution Removal Rule

- Do not include, preserve, or reproduce any reference to source names, platforms, publishers, or third-party materials (e.g., Smartypance, UWorld, Rosh, etc.) in the output.
- This applies to headings, structural orientation labels, and inline text.
- Cards must be written as standalone clinical knowledge statements without attribution.

---

## Third-Party Test Prep Source Rule

- When content originates from third-party test preparation sources or includes instructional or conversational phrasing (e.g., think of, buzzwords, classic presentation), remove the instructional phrasing and re-express the content as a neutral, clinically structured statement.
- Preserve all underlying medical facts, mechanisms, relationships, and qualifiers exactly.

---

## Cloze Styling Rules

- Apply inline HTML bold and blue styling to all clozed terms using the color #1f77b4.
- Wrap each clozed term as follows: <span style="color:#1f77b4"><b>{{cX::term}}</b></span>.
- Do not apply color coding, highlights, or additional HTML styling beyond blue bold to clozed terms.
- Bold non-clozed words without color or highlight when they function as any of the following: structural orientation labels explicitly present in the original text such as section headers, stage names, phase names, timing markers, or categorical labels; explicit emphasis qualifiers present in the source such as most common, most important, gold standard, first line, and contraindicated; or key clinical anchor terms that orient the student to the clinical context, mechanism, or decision point being tested.
- Do not bold filler words, prepositions, conjunctions, or non-clinical connecting language.
- Bolding of non-clozed terms applies on both the front and back of the card as it is part of the card text itself.
- All bold and emphasis must use <b>...</b> HTML tags; never use markdown bold (** or *) anywhere in the output.

---

Maintain in-depth detail and exam-level depth.
