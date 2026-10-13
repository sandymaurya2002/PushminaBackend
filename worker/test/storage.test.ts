import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, createAdmin, createProduct, tinyPng } from "./helpers";

function upload(token: string, files: Array<{ bytes: Uint8Array; name: string; type: string }>, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const file of files) form.append("files", new File([file.bytes], file.name, { type: file.type }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return call("/api/v1/admin/media", { method: "POST", token, form });
}

describe("R2 media", () => {
  it("stores a sniffed image under a generated key and serves it publicly", async () => {
    const admin = await createAdmin("EDITOR");
    const result = await upload(admin.token, [{ bytes: tinyPng(), name: "shawl.png", type: "image/png" }]);
    expect(result.status).toBe(201);
    const asset = result.json.data[0];
    expect(asset.key).toMatch(/^products\/[0-9a-f-]{36}\.png$/);
    expect(asset).toMatchObject({ mimeType: "image/png", width: 1, height: 1, isPublic: true });
    expect(await env.MEDIA.head(asset.key)).not.toBeNull();

    const served = await call(asset.path);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("trusts the file bytes, not the declared type or extension", async () => {
    const admin = await createAdmin("EDITOR");
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const result = await upload(admin.token, [{ bytes: html, name: "evil.png", type: "image/png" }]);
    expect(result.status).toBe(400);

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(admin.token, [{ bytes: svg, name: "logo.svg", type: "image/svg+xml" }])).status).toBe(400);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM media_objects WHERE original_name IN ('evil.png', 'logo.svg')`).first<{ n: number }>())?.n).toBe(0);
  });

  it("keeps private objects private and refuses keys outside the registry", async () => {
    const admin = await createAdmin("EDITOR");
    const result = await upload(admin.token, [{ bytes: tinyPng(), name: "private.png", type: "image/png" }], { public: "false", folder: "misc" });
    const asset = result.json.data[0];
    expect(asset.isPublic).toBe(false);
    expect((await call(asset.path)).status).toBe(404);

    await env.MEDIA.put("misc/00000000-0000-4000-8000-000000000000.png", tinyPng());
    expect((await call("/media/misc/00000000-0000-4000-8000-000000000000.png")).status).toBe(404);
    expect((await call("/media/../secrets.txt")).status).toBe(404);

    const toggled = await call(`/api/v1/admin/media/${asset.id}`, { method: "PATCH", token: admin.token, body: { isPublic: true } });
    expect(toggled.status).toBe(200);
    expect((await call(asset.path)).status).toBe(200);
  });

  it("supports conditional requests", async () => {
    const admin = await createAdmin("EDITOR");
    const asset = (await upload(admin.token, [{ bytes: tinyPng(), name: "etag.png", type: "image/png" }])).json.data[0];
    const first = await call(asset.path);
    const etag = first.headers.get("etag")!;
    const second = await call(asset.path, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
  });

  it("refuses to delete an image a product uses, then deletes from R2 and D1", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const asset = (await upload(admin.token, [{ bytes: tinyPng(), name: "used.png", type: "image/png" }])).json.data[0];
    const product = await createProduct(admin.token, { images: [{ url: asset.path, alt: "Used" }] });
    const blocked = await call(`/api/v1/admin/media/${asset.id}`, { method: "DELETE", token: admin.token });
    expect(blocked.status).toBe(409);

    await call(`/api/v1/admin/products/${product.id}`, { method: "DELETE", token: admin.token });
    const removed = await call(`/api/v1/admin/media/${asset.id}`, { method: "DELETE", token: admin.token });
    expect(removed.status).toBe(204);
    expect(await env.MEDIA.head(asset.key)).toBeNull();
    expect((await call(asset.path)).status).toBe(404);
  });

  it("requires media permissions", async () => {
    const support = await createAdmin("SUPPORT");
    expect((await upload(support.token, [{ bytes: tinyPng(), name: "x.png", type: "image/png" }])).status).toBe(403);
  });
});
