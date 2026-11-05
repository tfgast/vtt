/**
 * The page entry (vtt-3l6.17): `startApp` reads the session bootstrap and
 * renders the app, or the "No authority running" screen without one.
 */
import { startApp } from "./App";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Missing #root element");
}

startApp({ container });
