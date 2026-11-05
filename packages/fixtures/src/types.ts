/**
 * Scenario types, inferred from the zod schema so the two cannot drift.
 * See docs/FIXTURES.md for what each form means.
 */
import type { z } from "zod";
import type {
  ActionSchema,
  BoardSchema,
  CellContentSchema,
  DestinationSchema,
  DiceScriptEntrySchema,
  DoSchema,
  ErrorCodeSchema,
  ExpectationSchema,
  FormulaSchema,
  LogEffectSchema,
  ObjectSchema,
  PermutationSchema,
  PlacementSchema,
  RefValueSchema,
  RejectionReasonSchema,
  RollValueSchema,
  ScenarioSchema,
  SetupSchema,
  ShapeSchema,
  StepSchema,
  ValueSchema,
  ViewerEntrySchema,
  ViewersValueSchema,
} from "./schema";

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Setup = z.infer<typeof SetupSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type TableObject = z.infer<typeof ObjectSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type Shape = z.infer<typeof ShapeSchema>;
export type Action = z.infer<typeof ActionSchema>;

export type Value = z.infer<typeof ValueSchema>;
export type RefValue = z.infer<typeof RefValueSchema>;
export type RollValue = z.infer<typeof RollValueSchema>;
export type ViewersValue = z.infer<typeof ViewersValueSchema>;
export type ViewerEntry = z.infer<typeof ViewerEntrySchema>;
export type Formula = z.infer<typeof FormulaSchema>;
export type CellContent = z.infer<typeof CellContentSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type DiceScriptEntry = z.infer<typeof DiceScriptEntrySchema>;
export type Permutation = z.infer<typeof PermutationSchema>;

export type Step = z.infer<typeof StepSchema>;
export type Do = z.infer<typeof DoSchema>;
export type Destination = z.infer<typeof DestinationSchema>;

export type Expectation = z.infer<typeof ExpectationSchema>;
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;
export type LogEffect = z.infer<typeof LogEffectSchema>;
