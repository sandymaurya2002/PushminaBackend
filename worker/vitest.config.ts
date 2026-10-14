import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_ORIGIN: "https://admin.test",
            FRONTEND_ORIGIN: "https://shop.test",
            ENABLE_COD_ORDERS: "true",
            GATEWAY_SECRET: "test-gateway-secret",
            // Razorpay calls go to a fake host that test/razorpay-mock.ts answers.
            RAZORPAY_KEY_ID: "rzp_test_mockkey",
            RAZORPAY_KEY_SECRET: "test-key-secret",
            RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret",
            RAZORPAY_API_BASE: "https://razorpay.mock/v1",
            STOREFRONT_URL: "https://shop.test",
            // Pinned so a developer's local .dev.vars never changes test behaviour.
            REVALIDATE_SECRET: "",
            RESEND_API_KEY: "",
            EMAIL_DEV_LOG: "false",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 30_000,
    },
  };
});
