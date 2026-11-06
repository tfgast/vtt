/**
 * The MCP server's `instructions`, sent in the `initialize` result (DESIGN.md
 * §5.2; PROTOCOL.md §11; M6-D6): a short orientation naming the resources,
 * the first queries, that reading user cells needs `cells: "all"`
 * (vtt-qf5.53), the GM binder's templates, how to give a template to a
 * character (its owner set to the binder's, M6-D15), and the stale-write
 * rule. Every backticked identifier is checked against what it names by
 * test/mcp/instructions.test.ts.
 */
export const MCP_INSTRUCTIONS = [
  'You are attached to one table of "A Table of Dumb Objects", a virtual tabletop where every object is a bag of cells (literals or formulas) and rules attach to space.',
  "Read the resources vtt://docs/design (the model; section 4.7 lists the example templates) and vtt://docs/formulas (the formula and action language) before writing formulas or actions.",
  "Start with `table_info`, then `list_objects` or `zones` for a board. `get_objects` shows cells, formulas and actions; `explain_cell` shows why a value is what it is.",
  '`list_objects` returns only structural cells (position, tag and the like) unless you pass `cells: "all"`. To read user cells, such as the stats on a character\'s sheet, call `get_objects` with `cells: "all"` (its default; "structural" hides them).',
  "The GM binder `gm_binder` holds example templates: `tpl_character`, `tpl_attack`, `tpl_damage`, `tpl_area_save`, `tpl_save_row`, `tpl_token`, `tpl_zone`, `tpl_card`, `tpl_note`, `tpl_sheet`, `tpl_hand`, `tpl_binder`, `tpl_stack`, `tpl_d20`. They are examples: copy and edit them, never mutate them by play.",
  "To give a card to a character, `transact` a `spawn` of the template into that character's binder (the object in the character's contents tagged \"binder\") with `as` set to `$copy`, then `set_template_flag` on `$copy` with value true, then set its cells in the same batch: always set its `owner` to the binder's `owner` (the character), so the card's buttons pressed in the UI act as that character; for `tpl_area_save` also set `name`, `caster` and `damage_dice`; its `dc` follows the caster's `spell_dc`, which lives on the character's sheet (the character's `sheet` cell).",
  "Every `transact` carries the `base_revision` you last read. On `stale_write`, re-read and decide again; never resend blindly.",
  'Appearance is ordinary cells: `color`, `pattern` ("hatch"), `text`, `image` (import a local file with `import_asset`).',
  "Run an object's action with `invoke`. Undo your own latest group with `undo` and target `mine`.",
  "Rules that must outlive this conversation go into the table as formulas or actions.",
].join("\n");
