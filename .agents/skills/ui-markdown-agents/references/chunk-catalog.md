# Chunk catalog — wire type to render contract

Normative mapping from AG-UI event/chunk types to the rendering rules in
SKILL.md. The table in SKILL.md is the human contract; this file is the
machine checklist. When the AG-UI spec adds a type: add a row, a renderer,
and a BDD scenario.

Required BDD fixture (mixed turn): text + code block + mermaid + tool call
(start/args/end) + state delta + skill activation + memory recall + citation
+ error + confirmation request. Assertion: zero dropped chunks, every block
copyable, every non-text chunk collapsible, error fully expanded content
reachable, skill card visible with source label.
