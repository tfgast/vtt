import { cleanup, render, screen } from "@testing-library/react";
import { App } from "@vtt/ui";
import { afterEach, expect, test } from "vitest";

afterEach(cleanup);

test("renders the project name", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "A Table of Dumb Objects" })).toBeDefined();
});
