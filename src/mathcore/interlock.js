// A deterministic envelope for commands that move something physical or irreversible.
//
// The rule this encodes: a model, a prompt or a JSON schema is never the thing that enforces a
// limit. A fixed function with declared limits decides, the device's own reading confirms, and a
// person approves before anything is energised. This module is that function. It executes
// nothing and talks to no device; it returns allow or deny with every reason, and is meant to sit
// in the trusted local process between an agent's request and a device driver.
//
// A channel declares { min, max, maxStep?, maxRatePerSecond?, tolerance?, requiresConfirmation? }.

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {{min:number, max:number, maxStep?:number, maxRatePerSecond?:number,
 *   tolerance?:number, requiresConfirmation?:boolean}} channel
 * @param {{value:number, confirmed?:boolean}} command
 * @param {{value:number, ageSeconds:number}|null} last the last reading the device itself reported
 * @returns {{allow:boolean, reasons:string[]}}
 */
export function checkCommand(channel, command, last) {
  const reasons = [];
  if (!finite(channel?.min) || !finite(channel?.max) || channel.min > channel.max)
    return { allow: false, reasons: ["the channel declares no valid range"] };
  if (!finite(command?.value)) return { allow: false, reasons: ["the command is not a number"] };
  if (command.value < channel.min || command.value > channel.max)
    reasons.push(`value ${command.value} is outside [${channel.min}, ${channel.max}]`);
  const limited = finite(channel.maxStep) || finite(channel.maxRatePerSecond);
  if (limited) {
    // A step or rate limit is meaningless without a reading to measure the step from.
    if (!last || !finite(last.value) || !finite(last.ageSeconds) || last.ageSeconds < 0) {
      reasons.push("no device reading to measure the step from");
    } else {
      const step = Math.abs(command.value - last.value);
      if (finite(channel.maxStep) && step > channel.maxStep)
        reasons.push(`step ${step} exceeds the limit ${channel.maxStep}`);
      if (finite(channel.maxRatePerSecond)) {
        const allowed = channel.maxRatePerSecond * last.ageSeconds;
        if (step > allowed)
          reasons.push(
            `step ${step} exceeds ${channel.maxRatePerSecond}/s over ${last.ageSeconds}s`,
          );
      }
    }
  }
  if (channel.requiresConfirmation === true && command.confirmed !== true)
    reasons.push("a person has not confirmed this command");
  return { allow: reasons.length === 0, reasons };
}

/**
 * Did the device end where it was told to? A command is not done until its own reading says so.
 * @param {{tolerance?:number}} channel
 * @param {number} commanded
 * @param {number} measured
 */
export function echoMatches(channel, commanded, measured) {
  if (!finite(commanded) || !finite(measured)) return false;
  return Math.abs(commanded - measured) <= (finite(channel?.tolerance) ? channel.tolerance : 0);
}
