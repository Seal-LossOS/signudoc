import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultDelivery, emailDeliveryAvailable } from "./delivery.ts";

// Which delivery a send gets when it names none.

const POSTMARK = {
  EMAIL_DRIVER: "postmark",
  POSTMARK_FROM_EMAIL: "Acme <sign@acme.test>",
  POSTMARK_TOKEN: "postmark-test-token",
};

test("email off sends by link, whatever the default says", () => {
  assert.equal(defaultDelivery({ EMAIL_DRIVER: "off" }), "link");
  assert.equal(
    defaultDelivery({ DEFAULT_SIGNING_DELIVERY: "email", EMAIL_DRIVER: "off" }),
    "link",
  );
  // Postmark with a setting missing is off too.
  assert.equal(defaultDelivery({ EMAIL_DRIVER: "postmark" }), "link");
  assert.equal(emailDeliveryAvailable({ EMAIL_DRIVER: "off" }), false);
});

test("working email follows DEFAULT_SIGNING_DELIVERY", () => {
  assert.equal(
    defaultDelivery({ ...POSTMARK, DEFAULT_SIGNING_DELIVERY: "link" }),
    "link",
  );
  assert.equal(defaultDelivery(POSTMARK), "email");
  assert.equal(emailDeliveryAvailable(POSTMARK), true);
});

test("an unset default is email, upstream's behaviour", () => {
  assert.equal(defaultDelivery({}), "email");
  assert.equal(defaultDelivery({ EMAIL_DRIVER: "capture" }), "email");
  assert.equal(emailDeliveryAvailable({}), true);
});

test("the default is read in any case", () => {
  assert.equal(
    defaultDelivery({
      DEFAULT_SIGNING_DELIVERY: "LINK",
      EMAIL_DRIVER: "capture",
    }),
    "link",
  );
  assert.equal(
    defaultDelivery({
      DEFAULT_SIGNING_DELIVERY: " Link ",
      EMAIL_DRIVER: "capture",
    }),
    "link",
  );
});

test("a default that is not a delivery is email", () => {
  assert.equal(
    defaultDelivery({ DEFAULT_SIGNING_DELIVERY: "whatsapp" }),
    "email",
  );
  assert.equal(
    defaultDelivery({ DEFAULT_SIGNING_DELIVERY: "embedded" }),
    "email",
  );
});
