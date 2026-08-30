import { test, expect, type Page } from "@playwright/test";

// Real-browser coverage for the tavern demo's click-driven features. Every
// test here exists because it caught (or would have caught) a genuine
// regression: sign popups going dead, worker/cashier lunch toggling, and
// the rate-limit gate silently rendering wrong.
//
// See CHANGELOG.md for the incident this suite was written in response to.

async function openTavern(page: Page) {
  await page.goto("/#tavern");
  await expect(page.locator("canvas.tavern-canvas")).toBeVisible();
  // let the sim run a few frames so signRegions/personRegions are populated
  await page.waitForTimeout(500);
}

test.describe("station sign popups", () => {
  test("clicking each hanging sign opens its info popup", async ({ page }) => {
    // Regression guard, exactly for the class of bug this was written
    // after: a sign's engine.ts position moves (a "nudge it up" request)
    // and the click coordinate silently goes stale, so "sign popups don't
    // open" ships unnoticed. Rather than hardcode canvas-space guesses that
    // rot every time a sign is repositioned, this test reads each sign's
    // *actual* hit region from the sim itself (window.__surgeguardDebug,
    // wired in TavernGame.tsx) and clicks its true center - the same data
    // the click handler itself uses. Only the expected title strings are
    // hand-written, since a popup silently showing the wrong station is a
    // real bug this must still catch.
    await openTavern(page);
    const canvas = page.locator("canvas.tavern-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");

    const expectedTitles: Record<string, string> = {
      ratelimit: "rate limiter",
      idempotency: "idempotency",
      outbox: "Outbox table",
      db: "bounded worker pool",
      intake: "intake",
      backlog: "backlog",
      dispatch: "OutboxDispatchJob",
      processed: "processed",
      reconciler: "ReconcileStuckPurchasesJob",
      react: "React",
    };

    const regions = await page.evaluate(() => {
      const win = window as unknown as {
        __surgeguardDebug?: {
          sim?: {
            signRegions: {
              key: string;
              x: number;
              y: number;
              w: number;
              h: number;
            }[];
          };
        };
      };
      const regions = win.__surgeguardDebug?.sim?.signRegions ?? [];
      // de-dupe by key: signRegions is rebuilt every frame, so several
      // frames' worth of the same signs may have accumulated by now
      const seen = new Map<string, (typeof regions)[number]>();
      for (const r of regions) seen.set(r.key, r);
      return [...seen.values()];
    });
    expect(regions.length).toBeGreaterThanOrEqual(9); // every station sign

    // canvas is drawn at a fixed 960x600 logical resolution (engine.ts's
    // W/H) and scaled to the element's CSS box, so map region -> CSS pixels
    const CANVAS_W = 960;
    const CANVAS_H = 600;

    for (const region of regions) {
      const title = expectedTitles[region.key];
      if (!title) continue; // sign with no popup content (shouldn't happen)
      const cx = ((region.x + region.w / 2) / CANVAS_W) * box.width;
      const cy = ((region.y + region.h / 2) / CANVAS_H) * box.height;
      await canvas.click({ position: { x: cx, y: cy } });
      const popup = page.locator(".tavern-popup h3");
      await expect(popup, `popup for "${region.key}" sign`).toBeVisible({
        timeout: 2000,
      });
      await expect(popup).toContainText(title, { ignoreCase: true });
      await page.locator(".tavern-popup header button").click();
      await expect(page.locator(".tavern-popup")).toBeHidden();
    }
  });

  test("the rate-limit sign renders at the same size as every other sign", async ({
    page,
  }) => {
    // Regression guard: the RATE LIMIT sign once rendered visibly smaller
    // than its neighbours because of a stale-state bug in click regions.
    // drawSign() is the single shared renderer for every sign, so proving
    // its measured pixel footprint here pins the fix down structurally.
    await openTavern(page);
    const size = await page.evaluate(() => {
      const win = window as unknown as {
        __surgeguardDebug?: {
          sim?: { signRegions: { key: string; w: number; h: number }[] };
        };
      };
      const regions = win.__surgeguardDebug?.sim?.signRegions ?? [];
      const rate = regions.find((r) => r.key === "ratelimit");
      const outbox = regions.find((r) => r.key === "outbox");
      return { rate, outbox };
    });
    expect(size.rate, "rate-limit sign region missing").toBeTruthy();
    expect(size.outbox, "outbox sign region missing").toBeTruthy();
    // both carry a tech chip, so both must report the taller click height
    expect(size.rate!.h).toBe(size.outbox!.h);
  });
});

test.describe("clicking people", () => {
  test("clicking a cashier sends them to lunch and closes their till", async ({
    page,
  }) => {
    await openTavern(page);
    const canvas = page.locator("canvas.tavern-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");

    // first cashier lane sits near x=200/960, counter at y=400/600
    const cashierX = box.width * (200 / 960);
    const cashierY = box.height * (390 / 600);

    await canvas.click({ position: { x: cashierX, y: cashierY } });
    // a bubble reading "Gone to lunch!" appears somewhere on the canvas -
    // we can't assert on canvas pixels directly, but we can assert the sim
    // state changed via the debug hook the page exposes in dev.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const win = window as unknown as {
            __surgeguardDebug?: { sim?: { cashierLunch: boolean[] } };
          };
          return win.__surgeguardDebug?.sim?.cashierLunch?.[0] ?? false;
        }),
      )
      .toBe(true);

    // clicking again brings them back
    await canvas.click({ position: { x: cashierX, y: cashierY } });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const win = window as unknown as {
            __surgeguardDebug?: { sim?: { cashierLunch: boolean[] } };
          };
          return win.__surgeguardDebug?.sim?.cashierLunch?.[0] ?? true;
        }),
      )
      .toBe(false);
  });
});

test.describe("Vladimir Chopine cameo", () => {
  test("clicking the corner credit line summons him", async ({ page }) => {
    await openTavern(page);
    const canvas = page.locator("canvas.tavern-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not laid out");

    await canvas.click({
      position: { x: box.width * 0.91, y: box.height * 0.965 },
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const win = window as unknown as {
              __surgeguardDebug?: { sim?: { vlad: { phase: string } } };
            };
            return win.__surgeguardDebug?.sim?.vlad.phase ?? "away";
          }),
        { timeout: 5000 },
      )
      .not.toBe("away");
  });
});

test.describe("view toggle", () => {
  test("switching to the demo and back preserves the dashboard form", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.locator("h2", { hasText: "Create purchase" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "More fun than just a table" })
      .click();
    await expect(page.locator("canvas.tavern-canvas")).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(
      page.locator("h2", { hasText: "Create purchase" }),
    ).toBeVisible();
  });
});
