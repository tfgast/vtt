/**
 * Conversion from the fixture encoding (docs/FIXTURES.md §2) to schema values.
 * The two encodings are the same JSON; the conversion is a checked cast
 * through the schema's runtime guards, so a fixture value the schema would
 * not store fails loudly instead of reaching the evaluator.
 */
import type { CellContent as FixtureContent, Value as FixtureValue } from "@vtt/fixtures";
import { type CellContent, isCellContent, isValue, type Value } from "@vtt/schema";

/** A fixture value as a schema value. Throws when `isValue` rejects it. */
export function fromFixtureValue(v: FixtureValue): Value {
  if (!isValue(v)) throw new Error(`not a schema value: ${JSON.stringify(v)}`);
  return v;
}

/** A fixture cell content (value or formula) as schema cell content. Throws when `isCellContent` rejects it. */
export function fromFixtureContent(c: FixtureContent): CellContent {
  if (!isCellContent(c)) throw new Error(`not schema cell content: ${JSON.stringify(c)}`);
  return c;
}
