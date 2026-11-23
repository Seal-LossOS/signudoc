import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { e2eOutboxDir } from "../playwright.config";
import { signInAsAdministrator } from "./support/admin-session";
import { waitForEmail, type CapturedEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator. The sender sends by link, copies the signer's link from the
// envelope page, and the signer signs with it; SignuDoc emails no
// invitation.

const SIGNER = { email: "lena.link@example.com", name: "Lena Link" };

/** Every captured email to this address with this template. */
async function capturedEmails(template: string, to: string) {
  let fileNames: string[];

  try {
    fileNames = await readdir(e2eOutboxDir);
  } catch {
    return [];
  }

  const emails = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(
        async (fileName) =>
          JSON.parse(
            await readFile(path.join(e2eOutboxDir, fileName), "utf8"),
          ) as CapturedEmail,
      ),
  );

  return emails.filter(
    (email) => email.template === template && email.to.includes(to),
  );
}

test("a sender copies a signer's link, the same one twice, and the signer signs with it", async ({
  browser,
}, testInfo) => {
  // A fresh context that may read what the page copies.
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const readClipboard = () =>
    page.evaluate(() => navigator.clipboard.readText());
  let envelopeUrl = "";
  let copiedLink = "";

  await test.step("the sender sends an envelope by link", async () => {
    const senderEmail = await signInAsAdministrator(page);

    expect(senderEmail).not.toBe("");

    const pdfPath = await writeSamplePdf(testInfo.outputPath("link.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Delivered by hand");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill(SIGNER.name);
    await page.getByLabel("Signer 1 email").fill(SIGNER.email);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    const placementTarget = page.getByLabel("Place Signature on page 1");

    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.6 },
    });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);

    // The test server emails (capture driver), so the screen starts on
    // email and offers link delivery as the sender's choice.
    const howTheyGetIt = page.getByLabel("How signers get their link");

    await expect(howTheyGetIt).toHaveValue("email");
    await howTheyGetIt.selectOption("link");
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
    envelopeUrl = page.url();
  });

  await test.step("Copy link copies the signer's link, and the same one again", async () => {
    const signerRow = page
      .getByRole("listitem")
      .filter({ hasText: SIGNER.email });
    const copyButton = signerRow.getByRole("button", { name: "Copy link" });

    // Reminders are the sender's to send now, not SignuDoc's.
    await expect(
      page.getByRole("button", { name: "Send reminder" }),
    ).toHaveCount(0);

    await copyButton.click();
    await expect(signerRow.getByRole("status")).toHaveText("Copied");
    copiedLink = await readClipboard();
    expect(new URL(copiedLink).pathname).toMatch(/^\/sign\/[A-Za-z0-9_-]+$/);

    await page.evaluate(() => navigator.clipboard.writeText(""));
    await copyButton.click();
    await expect.poll(readClipboard).toBe(copiedLink);
  });

  await test.step("the signer signs with the copied link", async () => {
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const signerPage = await signerContext.newPage();

    await signerPage.goto(copiedLink);

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await expect(consent).toBeHidden();
    await signerPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await signerPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await signerPage.getByRole("button", { name: "Finish" }).click();
    await signerPage
      .getByRole("dialog", { name: "Finish signing?" })
      .getByRole("button", { name: "Finish signing" })
      .click();
    await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
    await signerContext.close();
  });

  await test.step("the envelope is completed, and nobody was emailed an invitation", async () => {
    // The finished copy is the last email of a completion.
    await waitForEmail({
      template: "completion_notification",
      to: SIGNER.email,
    });
    await page.goto(envelopeUrl);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    expect(await capturedEmails("signing_invitation", SIGNER.email)).toEqual(
      [],
    );
    await context.close();
  });
});
