import { defineConfig } from "vitest/config";
import { requireTestsInEveryProject } from "./vitest.reporters";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    reporters: ["default", requireTestsInEveryProject()],
  },
});
