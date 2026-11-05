/**
 * The scenario runner helpers other packages' tests import, at the dev-only
 * subpath `@vtt/authority/test-runner` (M5-D22; CLAUDE.md Conventions):
 * the setup document, the direct runner and its report, and the fixture
 * value comparison.
 */
export { fixtureValueEquals } from "./expect";
export { type RunOptions, type RunReport, runScenario, type StepReport } from "./run";
export { documentFromSetup } from "./setup";
