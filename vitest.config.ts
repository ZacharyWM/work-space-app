// root vitest config: picks up unit tests in shared/ (client logic lives in
// shared); the Go server's tests run via `npm run server:test`
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/src/**/*.test.ts"],
  },
});
