// client entry: applies the theme, then mounts the react root inside clerk's
// auth context (notes/005)
import { ClerkProvider } from "@clerk/clerk-react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme";
import "./styles.css";

// publishable key baked in at build time; fail loudly rather than render an
// app whose join can never authenticate
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is missing (client/.env.local)");
}

// CSS variables must exist before anything styled with them renders (step 4.1)
applyTheme();
// index.html always ships #root, so the assertion is safe
createRoot(document.getElementById("root")!).render(
  <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
    <App />
  </ClerkProvider>,
);
