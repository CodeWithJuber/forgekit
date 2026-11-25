// V2 corrections must be corroborated in the checkout that will serve them.
import { timingSafeEqual } from "node:crypto";
import { canonicalize, sealRecord } from "./ledger.js";
import { checkoutId, evidenceMac } from "./verify.js";

function correctionMac(root, claim, lesson, event) {
  return evidenceMac([
    "correction-outcome/v2",
    canonicalize([
      checkoutId(root),
      claim,
      lesson,
      event.oracle,
      event.result,
      event.ref,
      event.author,
      event.t,
    ]),
  ]);
}

export function signCorrectionOutcome(root, claim, lesson, outcome) {
  const { h: _hash, ...event } = outcome;
  const correctionMacV2 = correctionMac(root, claim, lesson, event);
  return correctionMacV2 ? sealRecord({ ...event, correctionMacV2 }) : null;
}

export function trustedCorrectionOutcome(root, claim, lesson, event) {
  const signature = event?.correctionMacV2;
  if (!root || typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = correctionMac(root, claim, lesson, event);
  return Boolean(
    expected && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex")),
  );
}
