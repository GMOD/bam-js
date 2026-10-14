# Agent documentation

Top level is exactly `TODO.md` and this file. Everything else is filed:

- `ideas/` — a proposal parked, one per file, in the subfolder naming what it
  waits on: `waiting-on-someone-else/` (upstream or data). Each file has `name:`
  and `description:` frontmatter, and the description says when someone should
  pick the idea up. A verdict leaves `ideas/`: an ADR if the decision deserves a
  record, otherwise deleted.
- `architecture-decision-records/` — _why_, one per file, `NNNN-slug.md`. Read
  the relevant one before "simplifying" a design that looks accidental.
- `handoffs/` — live state of an unfinished thread, as pointers rather than
  copied content. Delete a handoff when its thread lands.
- `todo/` — committed work, one file per item with `metadata.category`, `area`,
  `first_move` and `order`; `TODO.md` indexes them. It does not exist until
  there is an item. Commitment, not size, decides between `todo/` and `ideas/`.
- Tried and declined → a sentence at the code that would re-try it, with the
  number, rather than a rejected-ideas shelf.
- What a session did and which commits → git already holds it.

Cite a doc by its path, so a move is a grep. "State as of \<date\>" outside
`handoffs/` means split it into the homes above.
